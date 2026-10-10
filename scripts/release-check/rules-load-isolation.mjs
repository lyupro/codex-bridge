/** Isolates release-check installs because D13 and the 2026-10-10 UAC prompt forbid starting Codex or writing the operator's homes. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveBrandHome } from '../../src/home/lib/brand-home.mjs';
import { resolveCodexHome } from '../../src/home/lib/codex-home.mjs';
import { readLoadWitness } from '../../src/home/lib/load-witness.mjs';
import { parseJsonText } from '../../src/home/lib/json-file.mjs';

export const DELETED_ENV_NAMES = Object.freeze([
  'CLAUDECODE', 'CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_PROJECT_DIR',
  'GIT_DIR', 'GIT_WORK_TREE', 'NODE_OPTIONS', 'CODEX_BRIDGE_TEST_TMP',
]);
const TREE_PREFIX = 'codex-bridge-release-check-';
const RETRYABLE_CODES = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY']);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const envName = (name) => process.platform === 'win32' ? name.toUpperCase() : name;

export function createRoleTree({ role, tmpRoot = os.tmpdir(), run }) {
  if (typeof role !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(role)) {
    throw new Error('A safe release-check role name is required.');
  }
  if (typeof run !== 'function') throw new Error('The git runner is required.');
  const root = fs.mkdtempSync(path.join(tmpRoot, `${TREE_PREFIX}${role}-`));
  const tree = { root };
  for (const name of ['project', 'brand', 'codex', 'runs']) {
    tree[name] = path.join(root, name);
    fs.mkdirSync(tree[name]);
  }
  const result = run('git', ['init', '-q'], {
    cwd: tree.project, env: isolatedEnv({ baseEnv: process.env, tree }),
    shell: false, windowsHide: true, encoding: 'utf8', timeout: 10_000,
  });
  if (!result || result.error || result.signal || result.status !== 0) {
    throw new Error(`git init failed: ${result?.error?.message ?? result?.signal ?? result?.status}\n${result?.stderr ?? ''}`);
  }
  return tree;
}

export function isolatedEnv({ baseEnv, tree }) {
  if (!baseEnv || typeof baseEnv !== 'object') throw new Error('The base environment is required.');
  const env = { ...baseEnv };
  const roots = { CODEX_BRIDGE_HOME: tree.brand, CODEX_HOME: tree.codex, CODEX_RUNS_ROOT: tree.runs };
  for (const key of Object.keys(env)) {
    const name = envName(key);
    if ((name.startsWith('CLAUDE_CODE_') && name !== 'CLAUDE_CODE_OAUTH_TOKEN')
      || DELETED_ENV_NAMES.includes(name) || Object.hasOwn(roots, name)) delete env[key];
  }
  return Object.assign(env, roots);
}

function outputTail(result) {
  return [result?.stdout, result?.stderr].filter((part) => part != null).join('\n').slice(-4000);
}

export function installCandidate({ repositoryRoot, tree, env, run }) {
  try {
    if (!env || env.CODEX_BRIDGE_HOME !== tree.brand || env.CODEX_HOME !== tree.codex
      || env.CODEX_RUNS_ROOT !== tree.runs) {
      return { ok: false, reason: 'The installer requires the isolated environment for this tree.' };
    }
    const result = run(process.execPath, [path.join(repositoryRoot, 'bin', 'codex-bridge.mjs'), 'install', '--scope', 'project'], {
      cwd: tree.project, env, shell: false, windowsHide: true, encoding: 'utf8', timeout: 120_000,
    });
    if (!result || result.error || result.signal || result.status !== 0) {
      const cause = result?.error?.message ?? (result?.signal ? `signal ${result.signal}` : `exit ${result?.status}`);
      return { ok: false, reason: `Candidate install failed: ${cause}\n${outputTail(result)}`.trim() };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `Candidate install failed: ${error.message}\n${outputTail(error)}`.trim() };
  }
}

function installedCore(tree) {
  return path.join(tree.project, '.claude', 'rules', 'codex-bridge', 'core.md');
}

function installSnapshot(tree) {
  const hash = createHash('sha256');
  const files = [path.join(tree.brand, '.installed.json'), path.join(tree.project, '.claude', 'settings.json'), installedCore(tree)];
  for (const [index, file] of files.entries()) {
    const bytes = fs.readFileSync(file);
    if (index < 2) parseJsonText(file, bytes.toString('utf8'));
    if (index) hash.update('\0');
    hash.update(bytes);
  }
  return hash.digest('hex');
}

export function freezeInstall({ repositoryRoot, tree }) {
  const expectedPath = installedCore(tree);
  try {
    const installedHash = sha256(fs.readFileSync(expectedPath));
    const packagedHash = sha256(fs.readFileSync(path.join(repositoryRoot, 'src', 'claude', 'rules', 'core.md')));
    if (installedHash !== packagedHash) return { invariant: 'Installed core differs from the candidate core bytes.' };
    return { expectedPath, sha256: installedHash, snapshot: installSnapshot(tree) };
  } catch (error) {
    return { invariant: `Cannot freeze install: ${error.code === 'ENOENT' ? 'missing file' : error.message} (${error.path ?? expectedPath})` };
  }
}

export function recheckFrozen({ tree, frozen }) {
  try {
    if (sha256(fs.readFileSync(installedCore(tree))) !== frozen.sha256) return 'core bytes changed';
  } catch (error) {
    if (error.code === 'ENOENT') return 'core bytes changed';
    return `Cannot recheck core: ${error.message}`;
  }
  try {
    return installSnapshot(tree) === frozen.snapshot ? null : 'install snapshot changed';
  } catch (error) {
    if (error.code === 'ENOENT') return 'install snapshot changed';
    return `Cannot recheck install snapshot: ${error.message}`;
  }
}

function fileDigest(file) {
  try {
    return sha256(fs.readFileSync(file));
  } catch (error) {
    if (error.code === 'ENOENT') return 'absent';
    throw error;
  }
}

export function realStateSentinel({ env }) {
  if (!env || typeof env !== 'object') throw new Error('The original environment is required.');
  const record = path.join(resolveBrandHome({ env }).root, '.installed.json');
  const sentinel = { [record]: fileDigest(record) };
  const rules = path.join(resolveCodexHome({ env }), 'rules');
  let entries;
  try {
    entries = fs.readdirSync(rules, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return sentinel;
    throw error;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(rules, entry.name);
    if (entry.isFile() || (entry.isSymbolicLink() && fs.statSync(file).isFile())) sentinel[file] = fileDigest(file);
  }
  return sentinel;
}

export function compareSentinel(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((file) => before[file] !== after[file]).sort();
}

function normalizedPath(value) {
  const normalized = path.resolve(value).replaceAll('\\', '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function escapedWitness({ realStateDir, tree }) {
  const witness = readLoadWitness({ stateDir: realStateDir });
  if (witness.corrupt) throw new Error('Cannot inspect a corrupt real load witness.');
  const root = normalizedPath(tree.root);
  return Object.entries(witness.sessions).filter(([, session]) => {
    if (typeof session?.cwd !== 'string' || !session.cwd) return false;
    const cwd = normalizedPath(session.cwd);
    return cwd === root || cwd.startsWith(`${root}/`);
  }).map(([id]) => id);
}

export async function removeRoleTree({ tree, tmpRoot }) {
  try {
    const root = path.resolve(tree.root);
    if (path.dirname(root) !== path.resolve(tmpRoot) || !path.basename(root).startsWith(TREE_PREFIX)) {
      return { ok: false, reason: 'Refusing removal: role tree must be a prefixed direct child of tmpRoot.' };
    }
    const deadline = Date.now() + 2000;
    for (;;) {
      try {
        await fs.promises.rm(root, { recursive: true, force: true });
        return { ok: true };
      } catch (error) {
        if (!RETRYABLE_CODES.has(error.code) || Date.now() >= deadline) {
          return { ok: false, reason: `Cannot remove role tree: ${error.message}` };
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  } catch (error) {
    return { ok: false, reason: `Cannot remove role tree: ${error.message}` };
  }
}
