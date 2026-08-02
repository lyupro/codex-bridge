/** Defines install mappings and validates the persisted installation record. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = path.resolve(HERE, '..');
export const INSTALL_RECORD_NAME = '.codex-bridge-install.json';
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

export async function fileFingerprint(absolutePath) {
  try {
    return createHash('sha256').update(await fs.readFile(absolutePath)).digest('hex');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
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
  if (!record.hook || typeof record.hook !== 'object' || Array.isArray(record.hook)) {
    throw new Error('installation record hook must be an object');
  }
  if (record.hook.event !== 'SubagentStop' || typeof record.hook.path !== 'string' || !record.hook.path) {
    throw new Error('installation record hook must identify SubagentStop and its path');
  }
  if (path.isAbsolute(record.hook.path) || record.hook.path.split(/[\\/]/).includes('..')) {
    throw new Error('installation record hook path must stay relative to the host root');
  }
  if (path.basename(record.hook.path) !== 'reply-guard.mjs' || !record.files.includes(record.hook.path)) {
    throw new Error('installation record hook path must name the installed reply-guard.mjs');
  }
  return record;
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
  return validateInstallRecord(parsed);
}

export async function writeInstallRecord(host, record) {
  validateInstallRecord(record);
  await fs.writeFile(installRecordPath(host), `${JSON.stringify(record, null, 2)}\n`);
}

export async function buildInstallPlan(host, packageRoot = PACKAGE_ROOT) {
  const files = [];
  const claimedSources = [];
  for (const mapping of INSTALL_TABLE) {
    for await (const relative of fs.glob(mapping.source, { cwd: packageRoot, exclude: claimedSources })) {
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
