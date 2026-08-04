/** Defines install mappings and validates the persisted installation record. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
// The hook table lives under src/ because the installed gate reads it too: cli/ is not copied
// into a host, so a definition kept here would be invisible to the very hook it describes.
import { HOOK_DEFINITIONS } from '../src/hook-definitions.mjs';

export { HOOK_DEFINITIONS };

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(HERE, '..');
export const INSTALL_RECORD_NAME = '.codex-bridge-install.json';
export const RULES_NAME = 'codex-bridge.rules';
const RULES_SOURCE = `src/rules/${RULES_NAME}`;
/**
 * Files the operator owns once they exist. Seeded on first install so the defaults are
 * visible and editable, then never written, never compared, never removed: run-config.json
 * is where a host states which model each mode runs on, and an installer that overwrites it
 * would erase that on the next update — the same way overwriting a .env would.
 */
export const SEEDED_SOURCES = Object.freeze(['src/run-config.json']);
const seededTargets = (host) =>
  new Set(SEEDED_SOURCES.map((source) => posix(
    path.relative(host.root, path.join(host.agentsDir, path.relative('src', source))),
  )));
export const INSTALL_TABLE = Object.freeze([
  { source: 'src/agents/*.md', target: 'agentsDir', processing: 'placeholders' },
  { source: 'src/commands/*.md', target: 'commandsDir', processing: 'placeholders' },
  { source: 'src/**', target: 'agentsDir', processing: 'copy' },
]);

const posix = (value) => value.split(path.sep).join('/');

export function replacePlaceholders(content, agentsDir) {
  return content.replaceAll('{{CODEX_BRIDGE_DIR}}', posix(path.resolve(agentsDir)));
}

export async function packageInfo(packageRoot = PACKAGE_ROOT) {
  const parsed = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  return { name: parsed.name, version: parsed.version };
}

export function installRecordPath(host) {
  return path.join(host.agentsDir, INSTALL_RECORD_NAME);
}

export function installedHookPath(host, definition) {
  return path.join(host.agentsDir, 'hooks', definition.file);
}

/** Where each seeded file comes from and where it goes; contents are copied verbatim. */
export function seedPlan(host, packageRoot = PACKAGE_ROOT) {
  return SEEDED_SOURCES.map((source) => ({
    source: path.join(packageRoot, source),
    target: path.join(host.agentsDir, path.relative('src', source)),
    processing: 'copy',
  }));
}

export function rulesPlan(host, packageRoot = PACKAGE_ROOT) {
  return {
    source: path.join(packageRoot, RULES_SOURCE),
    target: path.join(host.codexRulesDir, RULES_NAME),
    name: RULES_NAME,
  };
}

export async function fileFingerprint(absolutePath) {
  try {
    return createHash('sha256').update(await fs.readFile(absolutePath)).digest('hex');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Whether the recorded installation is exactly what this package would install right now. Install
 * and update both decide "nothing to do" by this question, so it is answered in one place: two
 * copies of the condition would drift the first time a field is added to the record.
 */
export function recordMatchesPackage(record, plan, currentPackage, fingerprints, ruleState) {
  return Boolean(record)
    && record.name === currentPackage.name
    && record.version === currentPackage.version
    && record.files.length === plan.length
    && record.files.every((file, index) => file === plan[index].relativeToHost)
    && Boolean(record.fingerprints)
    && plan.every((item) => record.fingerprints[item.relativeToHost] === fingerprints.get(item.relativeToHost))
    && (!ruleState || (record.rules?.path === ruleState.path
      && record.rules.fingerprint === ruleState.fingerprint));
}

export function validateInstallRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('installation record must be an object');
  }
  const strings = ['name', 'version', 'installedAt', 'mode'];
  for (const key of strings) {
    if (typeof record[key] !== 'string' || !record[key]) throw new Error(`installation record has invalid ${key}`);
  }
  if (record.mode !== 'copy') throw new Error('installation record mode must be copy');
  if (Number.isNaN(Date.parse(record.installedAt))) throw new Error('installation record installedAt is invalid');
  if (!Array.isArray(record.files) || !record.files.length || record.files.some((file) => typeof file !== 'string' || !file)) {
    throw new Error('installation record files must be a non-empty list of strings');
  }
  if (record.files.some((file) => path.isAbsolute(file) || file.split(/[\\/]/).some((part) => part === '..' || part === '.'))) {
    throw new Error('installation record files must stay relative to the host root');
  }
  if (new Set(record.files).size !== record.files.length) {
    throw new Error('installation record files must not contain duplicates');
  }
  // Run artifacts are the user's data, not ours. Refusing them here means neither uninstall nor
  // update needs its own guard against deleting a run folder someone listed as an installed file.
  if (record.files.some((file) => file === 'codex-runs' || file.split(/[\\/]/)[0] === 'codex-runs')) {
    throw new Error('installation record files must not name run artifacts under codex-runs');
  }
  if (record.fingerprints !== undefined) {
    if (!record.fingerprints || typeof record.fingerprints !== 'object' || Array.isArray(record.fingerprints)) {
      throw new Error('installation record fingerprints must be an object');
    }
    const fingerprintKeys = Object.keys(record.fingerprints);
    if (fingerprintKeys.length !== record.files.length || fingerprintKeys.some((file) => !record.files.includes(file))) {
      throw new Error('installation record fingerprints keys must exactly match files');
    }
    if (Object.values(record.fingerprints).some((fingerprint) =>
      typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/i.test(fingerprint))) {
      throw new Error('installation record fingerprints must be 64-character hexadecimal SHA256 strings');
    }
  }
  if (record.rules !== undefined) {
    if (!record.rules || typeof record.rules !== 'object' || Array.isArray(record.rules)) {
      throw new Error('installation record rules must be an object');
    }
    if (typeof record.rules.path !== 'string' || !record.rules.path) {
      throw new Error('installation record rules path must be a non-empty string');
    }
    if (path.basename(record.rules.path) !== RULES_NAME) {
      throw new Error(`installation record rules path must name ${RULES_NAME}`);
    }
    if (typeof record.rules.fingerprint !== 'string'
      || !/^[a-f0-9]{64}$/i.test(record.rules.fingerprint)) {
      throw new Error('installation record rules fingerprint must be a 64-character hexadecimal SHA256 string');
    }
  }
  if (record.hooks !== undefined && record.hook !== undefined) {
    throw new Error('installation record must use hooks instead of hook');
  }
  const hooks = record.hooks !== undefined ? record.hooks : record.hook !== undefined ? [record.hook] : null;
  if (!Array.isArray(hooks) || !hooks.length) {
    throw new Error('installation record hooks must be a non-empty list');
  }
  for (const hook of hooks) {
    if (!hook || typeof hook !== 'object' || Array.isArray(hook)) {
      throw new Error('installation record hook must be an object');
    }
    const definition = HOOK_DEFINITIONS.find((entry) => entry.event === hook.event);
    if (!definition || typeof hook.path !== 'string' || !hook.path) {
      throw new Error('installation record hook must identify a supported event and its path');
    }
    if (path.isAbsolute(hook.path) || hook.path.split(/[\\/]/).includes('..')) {
      throw new Error('installation record hook path must stay relative to the host root');
    }
    if (path.basename(hook.path) !== definition.file || !record.files.includes(hook.path)) {
      throw new Error(`installation record hook path must name the installed ${definition.file}`);
    }
  }
  return record;
}

export function normalizeInstallRecord(record) {
  validateInstallRecord(record);
  if (record.hooks !== undefined) return record;
  const { hook, ...withoutLegacyHook } = record;
  return { ...withoutLegacyHook, hooks: [hook] };
}

export async function readInstallRecord(host) {
  let raw;
  try {
    raw = await fs.readFile(installRecordPath(host), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid installation record JSON: ${err.message}`);
  }
  const record = normalizeInstallRecord(parsed);
  // Earlier versions installed the config as a package file and recorded it. Dropping it here
  // is what stops the next update from calling the operator's edited config an orphan and
  // deleting it, and it needs no migration step: the record is rewritten on the next write.
  const seeded = seededTargets(host);
  record.files = record.files.filter((file) => !seeded.has(file));
  if (record.fingerprints) {
    record.fingerprints = Object.fromEntries(
      Object.entries(record.fingerprints).filter(([file]) => !seeded.has(file)),
    );
  }
  return record;
}

export async function writeInstallRecord(host, record) {
  const normalized = normalizeInstallRecord(record);
  await fs.writeFile(installRecordPath(host), `${JSON.stringify(normalized, null, 2)}\n`);
}

export async function buildInstallPlan(host, packageRoot = PACKAGE_ROOT) {
  const files = [];
  const claimedSources = [];
  for (const mapping of INSTALL_TABLE) {
    for await (const relative of fs.glob(mapping.source, { cwd: packageRoot, exclude: claimedSources })) {
      if (posix(relative) === RULES_SOURCE) continue;
      if (SEEDED_SOURCES.includes(posix(relative))) continue;
      const source = path.join(packageRoot, relative);
      if (!(await fs.stat(source)).isFile()) continue;
      const targetRelative = mapping.processing === 'copy'
        ? path.relative(path.join(packageRoot, 'src'), source)
        : path.basename(source);
      const target = path.join(host[mapping.target], targetRelative);
      files.push({
        source,
        target,
        relativeToHost: posix(path.relative(host.root, target)),
        processing: mapping.processing,
      });
    }
    claimedSources.push(mapping.source);
  }
  return files.sort((a, b) => a.relativeToHost.localeCompare(b.relativeToHost));
}
