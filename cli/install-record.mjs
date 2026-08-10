/** Reads, validates, and writes the installation record shared by installer commands. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { readJsonFile } from '../src/json-file.mjs';
import { HOOK_DEFINITIONS } from '../src/hook-definitions.mjs';

export const INSTALL_RECORD_NAME = '.installed.json';
export const LEGACY_INSTALL_RECORD_NAME = '.codex-bridge-install.json';
export const RULES_NAME = 'codex-bridge.rules';

const ROOTS = new Set(['claude', 'brand']);

const posix = (value) => value.split(path.sep).join('/');

export function fileEntry(file) {
  if (typeof file === 'string') return { root: 'claude', path: file };
  // Plan items carry the same root but call the relative field relativeToRoot; normalizing that
  // shape here keeps matching, fingerprint lookup, and display on one record-key contract.
  if (file?.path === undefined && file?.relativeToRoot !== undefined) {
    return { root: file.root, path: file.relativeToRoot };
  }
  return file;
}

export function recordFileKey(file) {
  const entry = fileEntry(file);
  return `${entry.root}:${entry.path}`;
}

export function recordTarget(host, file) {
  const entry = fileEntry(file);
  const root = entry.root === 'brand' ? host.brandRoot : host.root;
  if (!root) throw new Error(`host has no ${entry.root} installation root`);
  return path.join(root, entry.path);
}

export function recordRelativeToHost(host, file) {
  return posix(path.relative(host.root, recordTarget(host, file)));
}

export function definitionForRecordedHook(hook) {
  return HOOK_DEFINITIONS.find((definition) => definition.event === hook?.event
    && path.basename(String(hook?.path ?? '')) === definition.file);
}

function validPath(value, label) {
  if (typeof value !== 'string' || !value) throw new Error(`${label} must be a non-empty string`);
  if (path.isAbsolute(value) || value.split(/[\\/]/).some((part) => part === '..' || part === '.')) {
    throw new Error(`${label} must stay relative to its installation root`);
  }
  return value;
}

function normalizedFiles(record) {
  if (!Array.isArray(record.files) || !record.files.length) {
    throw new Error('installation record files must be a non-empty list');
  }
  const files = record.files.map((file) => {
    const entry = fileEntry(file);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('installation record files must contain root and path entries');
    }
    if (!ROOTS.has(entry.root)) throw new Error('installation record file root must be claude or brand');
    validPath(entry.path, 'installation record file path');
    // Run artifacts are the user's data, not ours. Refusing them here means neither uninstall nor
    // update needs its own guard against deleting a run folder someone listed as an installed file.
    if (entry.path === 'codex-runs' || entry.path.split(/[\\/]/)[0] === 'codex-runs') {
      throw new Error('installation record files must not name run artifacts under codex-runs');
    }
    return { root: entry.root, path: entry.path };
  });
  if (new Set(files.map(recordFileKey)).size !== files.length) {
    throw new Error('installation record files must not contain duplicates');
  }
  return files;
}

function fingerprintPairs(files, fingerprints) {
  if (!fingerprints || typeof fingerprints !== 'object' || Array.isArray(fingerprints)) {
    throw new Error('installation record fingerprints must be an object');
  }
  const fingerprintKeys = Object.keys(fingerprints);
  const nested = fingerprintKeys.some((key) => ROOTS.has(key));
  const pairs = files.map((file) => [file, nested
    ? fingerprints[file.root]?.[file.path]
    : file.root === 'claude' ? fingerprints[file.path] : undefined]);
  if (!nested) {
    if (files.some((file) => file.root !== 'claude')
      || fingerprintKeys.length !== files.length
      || files.some((file) => !Object.hasOwn(fingerprints, file.path))) {
      throw new Error('installation record fingerprints keys must exactly match files');
    }
  } else {
    const expectedRoots = new Set(files.map((file) => file.root));
    const actualRoots = new Set(fingerprintKeys);
    if (fingerprintKeys.some((root) => !ROOTS.has(root))
      || actualRoots.size !== expectedRoots.size
      || [...actualRoots].some((root) => !expectedRoots.has(root))
      || [...expectedRoots].some((root) => {
        const expected = files.filter((file) => file.root === root).map((file) => file.path);
        const actual = Object.keys(fingerprints[root] ?? {});
        return actual.length !== expected.length || expected.some((file) => !actual.includes(file));
      })) {
      throw new Error('installation record fingerprints keys must exactly match files');
    }
  }
  if (pairs.some(([, fingerprint]) => fingerprint === undefined)) {
    throw new Error('installation record fingerprints keys must exactly match files');
  }
  if (pairs.some(([, fingerprint]) => typeof fingerprint !== 'string'
    || !/^[a-f0-9]{64}$/i.test(fingerprint))) {
    throw new Error('installation record fingerprints must be 64-character hexadecimal SHA256 strings');
  }
  return pairs;
}

function validateHooks(record, files) {
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
    const definitions = HOOK_DEFINITIONS.filter((entry) => entry.event === hook.event);
    const entry = fileEntry(hook.root ? hook : { root: 'claude', path: hook.path });
    if (!definitions.length || typeof entry.path !== 'string' || !entry.path) {
      throw new Error('installation record hook must identify a supported event and its path');
    }
    if (!ROOTS.has(entry.root)) throw new Error('installation record hook root must be claude or brand');
    validPath(entry.path, 'installation record hook path');
    const definition = definitions.find((candidate) => path.basename(entry.path) === candidate.file);
    if (!definition || !files.some((file) => recordFileKey(file) === recordFileKey(entry))) {
      const names = definitions.map((candidate) => candidate.file).join(' or ');
      throw new Error(`installation record hook path must name the installed ${names}`);
    }
  }
}

export function validateInstallRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('installation record must be an object');
  }
  for (const key of ['name', 'version', 'installedAt', 'mode']) {
    if (typeof record[key] !== 'string' || !record[key]) throw new Error(`installation record has invalid ${key}`);
  }
  if (record.mode !== 'copy') throw new Error('installation record mode must be copy');
  if (Number.isNaN(Date.parse(record.installedAt))) throw new Error('installation record installedAt is invalid');
  const files = normalizedFiles(record);
  if (record.fingerprints !== undefined) fingerprintPairs(files, record.fingerprints);
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
  validateHooks(record, files);
  return record;
}

function normalizedHook(hook) {
  return hook.root ? { ...hook, root: hook.root, path: hook.path }
    : { ...hook, root: 'claude', path: hook.path };
}

function normalizedFingerprints(files, fingerprints) {
  if (fingerprints === undefined) return undefined;
  const pairs = fingerprintPairs(files, fingerprints);
  const result = {};
  for (const [file, fingerprint] of pairs) {
    result[file.root] ??= {};
    result[file.root][file.path] = fingerprint;
  }
  return result;
}

export function normalizeInstallRecord(record) {
  validateInstallRecord(record);
  const files = normalizedFiles(record);
  const hooks = record.hooks !== undefined ? record.hooks : [record.hook];
  const { hook: _legacyHook, ...withoutLegacyHook } = record;
  const normalized = {
    ...withoutLegacyHook,
    files,
    hooks: hooks.map(normalizedHook),
  };
  const fingerprints = normalizedFingerprints(files, record.fingerprints);
  if (fingerprints !== undefined) normalized.fingerprints = fingerprints;
  return normalized;
}

function legacySeedEntries(host) {
  const agentDirs = [host.agentsDir, host.legacyAgentsDir].filter(Boolean);
  return new Set(agentDirs.flatMap((agentsDir) => [
    { root: 'claude', path: posix(path.relative(host.root, path.join(agentsDir, 'run-config.json'))) },
    { root: 'claude', path: posix(path.relative(host.root, path.join(agentsDir, 'conventions.md'))) },
  ]).map(recordFileKey));
}

function newSeedEntries() {
  return new Set(['brand:config.json', 'brand:conventions.md']);
}

function withoutSeededFiles(host, record) {
  const seeded = new Set([...legacySeedEntries(host), ...newSeedEntries()]);
  record.files = record.files.filter((file) => !seeded.has(recordFileKey(file)));
  if (record.fingerprints) {
    const fingerprints = {};
    for (const file of record.files) {
      const value = record.fingerprints[file.root]?.[file.path];
      if (value !== undefined) {
        fingerprints[file.root] ??= {};
        fingerprints[file.root][file.path] = value;
      }
    }
    record.fingerprints = fingerprints;
  }
  return record;
}

async function readAt(recordPath) {
  try {
    return await readJsonFile(recordPath);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    if (err.cause) {
      throw new Error(`invalid installation record JSON: ${err.cause.message}`, { cause: err.cause });
    }
    throw err;
  }
}

export function installRecordPath(host) {
  return host.brandInstallRecordPath || path.join(host.brandRoot, INSTALL_RECORD_NAME);
}

export function legacyInstallRecordPath(host) {
  return path.join(host.legacyAgentsDir, LEGACY_INSTALL_RECORD_NAME);
}

export async function readInstallRecord(host) {
  const parsed = await readAt(installRecordPath(host));
  const legacy = parsed === null ? await readAt(legacyInstallRecordPath(host)) : null;
  if (parsed === null && legacy === null) return null;
  return withoutSeededFiles(host, normalizeInstallRecord(parsed ?? legacy));
}

export async function writeInstallRecord(host, record) {
  const normalized = normalizeInstallRecord(record);
  const target = installRecordPath(host);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(normalized, null, 2)}\n`);
}

export function fingerprintFor(record, file) {
  const entry = fileEntry(file);
  if (!record?.fingerprints) return undefined;
  if (record.fingerprints[entry.root]?.[entry.path] !== undefined) {
    return record.fingerprints[entry.root][entry.path];
  }
  return entry.root === 'claude' ? record.fingerprints[entry.path] : undefined;
}

export function recordMatchesPackage(record, plan, currentPackage, fingerprints, ruleState) {
  return Boolean(record)
    && record.name === currentPackage.name
    && record.version === currentPackage.version
    && record.files.length === plan.length
    && record.files.every((file, index) => recordFileKey(file) === recordFileKey(plan[index]))
    && Boolean(record.fingerprints)
    && plan.every((item) => fingerprintFor(record, item) === fingerprints.get(recordFileKey(item)))
    && (!ruleState || (record.rules?.path === ruleState.path
      && record.rules.fingerprint === ruleState.fingerprint));
}
