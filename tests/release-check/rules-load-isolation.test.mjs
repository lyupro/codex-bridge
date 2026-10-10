/** Guards throwaway release-check homes because D13 and the 2026-10-10 UAC prompt require isolation without a Codex launch. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { makeTempTree } from '../temp-tree.mjs';
import { repositoryRoot as findRepositoryRoot } from '../../cli/hosts.mjs';
import { readJsonFileSync } from '../../src/home/lib/json-file.mjs';
import {
  DELETED_ENV_NAMES, createRoleTree, isolatedEnv, installCandidate, freezeInstall,
  recheckFrozen, realStateSentinel, compareSentinel, escapedWitness, removeRoleTree,
} from '../../scripts/release-check/rules-load-isolation.mjs';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const tmpRoot = makeTempTree('rules-load-isolation-');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const makeTree = (role = 'cli') => createRoleTree({ role, tmpRoot, run: spawnSync });
const fixtureTree = () => createRoleTree({ role: 'fixture', tmpRoot, run: () => ({ status: 0 }) });

function writeFixtureInstall(tree) {
  const core = path.join(tree.project, '.claude', 'rules', 'codex-bridge', 'core.md');
  const settings = path.join(tree.project, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(core), { recursive: true });
  fs.copyFileSync(path.join(repositoryRoot, 'src', 'claude', 'rules', 'core.md'), core);
  fs.writeFileSync(path.join(tree.brand, '.installed.json'), '{}\n');
  fs.writeFileSync(settings, '{}\n');
  return { core, settings };
}

test('isolatedEnv strips host and Git state, preserves login, and replaces all three roots without mutation', () => {
  const tree = fixtureTree();
  const baseEnv = {
    ...Object.fromEntries(DELETED_ENV_NAMES.map((name) => [name, 'discard'])),
    CLAUDE_CODE_ENTRYPOINT: 'discard', CLAUDE_CODE_EXECPATH: 'discard',
    CLAUDE_CODE_FUTURE_SESSION_KEY: 'discard', CLAUDE_CODE_OAUTH_TOKEN: 'keep-token',
    CODEX_BRIDGE_HOME: 'real-brand', CODEX_HOME: 'real-codex', CODEX_RUNS_ROOT: 'real-runs',
    PATH: 'keep-path', HOME: 'keep-home', USERPROFILE: 'keep-profile', OTHER: 'keep-other',
  };
  const original = { ...baseEnv };
  const env = isolatedEnv({ baseEnv, tree });
  assert.deepEqual(baseEnv, original);
  assert.notEqual(env, baseEnv);
  for (const name of DELETED_ENV_NAMES) assert.equal(Object.hasOwn(env, name), false, name);
  for (const name of ['CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_FUTURE_SESSION_KEY']) {
    assert.equal(Object.hasOwn(env, name), false, name);
  }
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'keep-token');
  assert.equal(env.CODEX_BRIDGE_HOME, tree.brand);
  assert.equal(env.CODEX_HOME, tree.codex);
  assert.equal(env.CODEX_RUNS_ROOT, tree.runs);
  for (const name of ['PATH', 'HOME', 'USERPROFILE', 'OTHER']) assert.equal(env[name], baseEnv[name]);
  assert.throws(() => isolatedEnv({ tree }), /base environment is required/);
});

test('environment name comparison follows Windows case-insensitive semantics', () => {
  const tree = fixtureTree();
  const baseEnv = {
    claude_code_entrypoint: 'host', ClaudeCode: 'host', git_dir: 'host', node_options: 'host',
    codex_bridge_home: 'real-brand', Codex_Home: 'real-codex', codex_runs_root: 'real-runs',
    claude_code_oauth_token: 'keep-token',
  };
  const env = isolatedEnv({ baseEnv, tree });
  for (const key of Object.keys(baseEnv).filter((name) => name !== 'claude_code_oauth_token')) {
    assert.equal(Object.hasOwn(env, key), process.platform !== 'win32', key);
  }
  assert.equal(env.claude_code_oauth_token, 'keep-token');
  assert.equal(env.CODEX_HOME, tree.codex);
});

test('real git init creates a repository boundary inside a role tree', () => {
  const tree = makeTree();
  assert.equal(path.dirname(tree.root), tmpRoot);
  assert.match(path.basename(tree.root), /^codex-bridge-release-check-cli-/);
  for (const name of ['project', 'brand', 'codex', 'runs']) assert.ok(fs.statSync(tree[name]).isDirectory());
  assert.ok(fs.statSync(path.join(tree.project, '.git')).isDirectory());
  const nested = path.join(tree.project, 'nested', 'child');
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(findRepositoryRoot(nested), tree.project);
});

test('git init is injected, hidden, shell-free, timed, and protected from inherited Git overrides', () => {
  let called = false;
  const tree = createRoleTree({ role: 'vscode', tmpRoot, run(command, args, options) {
    called = true;
    assert.equal(command, 'git');
    assert.deepEqual(args, ['init', '-q']);
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    assert.ok(Number.isFinite(options.timeout) && options.timeout > 0);
    assert.equal(options.encoding, 'utf8');
    assert.equal(options.env.GIT_DIR, undefined);
    assert.equal(options.env.GIT_WORK_TREE, undefined);
    assert.equal(options.cwd, options.env.CODEX_BRIDGE_HOME.replace(/brand$/, 'project'));
    return { status: 0 };
  } });
  assert.ok(called);
  assert.match(path.basename(tree.root), /^codex-bridge-release-check-vscode-/);
});

test('git init failures throw with stderr, and required inputs stay loud', () => {
  for (const result of [
    { status: 1, stderr: 'git boundary refused' },
    { status: 0, signal: 'SIGTERM', stderr: 'git boundary refused' },
    { status: null, error: new Error('spawn failed'), stderr: 'git boundary refused' },
  ]) {
    assert.throws(() => createRoleTree({ role: 'cli', tmpRoot, run: () => result }), /git boundary refused/);
  }
  assert.throws(() => createRoleTree({ role: '../escape', tmpRoot, run: spawnSync }), /role name/);
  assert.throws(() => createRoleTree({ role: 'cli', tmpRoot }), /runner is required/);
});

test('installer uses only Node and the project install with the isolated environment and timeout', () => {
  const tree = fixtureTree();
  const env = isolatedEnv({ baseEnv: process.env, tree });
  const result = installCandidate({ repositoryRoot, tree, env, run(command, args, options) {
    assert.equal(command, process.execPath);
    assert.deepEqual(args, [path.join(repositoryRoot, 'bin', 'codex-bridge.mjs'), 'install', '--scope', 'project']);
    assert.deepEqual(options, {
      cwd: tree.project, env, shell: false, windowsHide: true, encoding: 'utf8', timeout: 120_000,
    });
    return { status: 0 };
  } });
  assert.deepEqual(result, { ok: true });
});

test('installer exit, signal, spawn errors, and thrown errors return reasons with bounded output tails', () => {
  const tree = fixtureTree();
  const env = isolatedEnv({ baseEnv: process.env, tree });
  for (const result of [
    { status: 9 }, { status: 0, signal: 'SIGTERM' }, { status: null, error: new Error('spawn rejected') },
  ]) {
    const failed = installCandidate({ repositoryRoot, tree, env, run: () => ({
      ...result, stdout: `discard-marker${'x'.repeat(4500)}`, stderr: 'output-tail-marker',
    }) });
    assert.equal(failed.ok, false);
    assert.match(failed.reason, /output-tail-marker/);
    assert.doesNotMatch(failed.reason, /discard-marker/);
  }
  assert.match(installCandidate({ repositoryRoot, tree, env, run() {
    throw Object.assign(new Error('runner threw'), { stderr: 'thrown-output' });
  } }).reason, /runner threw\n.*thrown-output/);
  assert.equal(installCandidate({ repositoryRoot, tree, run: spawnSync }).ok, false);
  assert.equal(installCandidate({ repositoryRoot, tree, env: process.env, run: spawnSync }).ok, false);
});

test('real candidate install freezes the exact project core and detects subsequent core edits', () => {
  const tree = makeTree();
  const env = isolatedEnv({ baseEnv: process.env, tree });
  const installed = installCandidate({ repositoryRoot, tree, env, run: spawnSync });
  assert.equal(installed.ok, true, installed.reason);
  const frozen = freezeInstall({ repositoryRoot, tree });
  assert.equal(frozen.invariant, undefined, frozen.invariant);
  assert.equal(frozen.expectedPath, path.join(tree.project, '.claude', 'rules', 'codex-bridge', 'core.md'));
  const bytes = fs.readFileSync(frozen.expectedPath);
  assert.equal(frozen.sha256, digest(bytes));
  assert.deepEqual(bytes, fs.readFileSync(path.join(repositoryRoot, 'src', 'claude', 'rules', 'core.md')));
  const record = fs.readFileSync(path.join(tree.brand, '.installed.json'));
  const settings = fs.readFileSync(path.join(tree.project, '.claude', 'settings.json'));
  assert.equal(frozen.snapshot, digest(Buffer.concat([record, Buffer.from('\0'), settings, Buffer.from('\0'), bytes])));
  assert.equal(recheckFrozen({ tree, frozen }), null);
  fs.appendFileSync(frozen.expectedPath, '\nchanged after freeze\n');
  assert.equal(recheckFrozen({ tree, frozen }), 'core bytes changed');
});

test('freeze rejects missing and mismatched core bytes', () => {
  const tree = fixtureTree();
  assert.match(freezeInstall({ repositoryRoot, tree }).invariant, /missing file/);
  const { core } = writeFixtureInstall(tree);
  fs.appendFileSync(core, '\nnot the packaged core\n');
  assert.match(freezeInstall({ repositoryRoot, tree }).invariant, /differs/);
});

test('frozen install snapshot detects changed installation record and project settings', () => {
  for (const name of ['record', 'settings']) {
    const tree = fixtureTree();
    const { settings } = writeFixtureInstall(tree);
    const frozen = freezeInstall({ repositoryRoot, tree });
    assert.equal(frozen.invariant, undefined);
    const file = name === 'record' ? path.join(tree.brand, '.installed.json') : settings;
    fs.writeFileSync(file, '{"changed":true}\n');
    assert.equal(recheckFrozen({ tree, frozen }), 'install snapshot changed');
  }
});

test('sentinel uses original home overrides and covers only the record and direct Codex rule files', () => {
  const tree = fixtureTree();
  const env = { CODEX_BRIDGE_HOME: tree.brand, CODEX_HOME: tree.codex };
  const record = path.join(tree.brand, '.installed.json');
  const rules = path.join(tree.codex, 'rules');
  const rule = path.join(rules, 'operator.md');
  fs.mkdirSync(path.join(rules, 'nested'), { recursive: true });
  fs.mkdirSync(path.join(tree.brand, 'state'));
  fs.writeFileSync(rule, 'operator rule');
  fs.writeFileSync(path.join(rules, 'nested', 'ignored.md'), 'nested rule');
  const before = realStateSentinel({ env });
  assert.deepEqual(before, { [record]: 'absent', [rule]: digest('operator rule') });
  fs.writeFileSync(path.join(tree.brand, 'state', 'load-witness.json'), '{"sessions":{}}');
  assert.deepEqual(compareSentinel(before, realStateSentinel({ env })), []);
  fs.writeFileSync(rule, 'changed rule');
  fs.writeFileSync(record, '{}');
  assert.deepEqual(compareSentinel(before, realStateSentinel({ env })), [record, rule].sort());
  assert.throws(() => realStateSentinel({}), /original environment/);
});

test('sentinel comparisons report added, removed, and changed files', () => {
  assert.deepEqual(compareSentinel({ unchanged: 'a', removed: 'b', changed: 'c' }, {
    unchanged: 'a', added: 'd', changed: 'e',
  }), ['added', 'changed', 'removed']);
  const tree = fixtureTree();
  const record = path.join(tree.brand, '.installed.json');
  assert.deepEqual(realStateSentinel({ env: { CODEX_BRIDGE_HOME: tree.brand, CODEX_HOME: tree.codex } }), { [record]: 'absent' });
});

test('escapedWitness finds only normalized role-tree cwd boundaries, not sibling prefixes or outside sessions', () => {
  const tree = fixtureTree();
  const realStateDir = path.join(tmpRoot, 'sentinel-state');
  fs.mkdirSync(realStateDir);
  const file = path.join(realStateDir, 'load-witness.json');
  const normalizedCwd = path.join(tree.project, '..', 'project').replaceAll('\\', '/');
  fs.writeFileSync(file, JSON.stringify({ sessions: {
    inside: { cwd: tree.project }, normalized: { cwd: normalizedCwd }, root: { cwd: tree.root },
    outside: { cwd: repositoryRoot }, prefix: { cwd: `${tree.root}-sibling` }, missing: {},
    caseVariant: { cwd: tree.project.toUpperCase() },
  } }));
  assert.equal(Object.keys(readJsonFileSync(file).sessions).length, 7);
  assert.deepEqual(escapedWitness({ realStateDir, tree }), [
    'inside', 'normalized', 'root', ...(process.platform === 'win32' ? ['caseVariant'] : []),
  ]);
  assert.deepEqual(escapedWitness({ realStateDir: path.join(tmpRoot, 'missing-state'), tree }), []);
  fs.writeFileSync(file, '{broken');
  assert.throws(() => escapedWitness({ realStateDir, tree }), /corrupt/);
});

test('cleanup refuses outside, unprefixed, and nested paths and removes a valid role tree', async () => {
  const tree = fixtureTree();
  const nested = path.join(tree.root, 'codex-bridge-release-check-nested');
  fs.mkdirSync(nested);
  for (const root of [repositoryRoot, tmpRoot, tree.project, nested]) {
    assert.equal((await removeRoleTree({ tree: { root }, tmpRoot })).ok, false);
    assert.ok(fs.statSync(root).isDirectory());
  }
  assert.deepEqual(await removeRoleTree({ tree, tmpRoot }), { ok: true });
  assert.throws(() => fs.statSync(tree.root), { code: 'ENOENT' });
  assert.deepEqual(await removeRoleTree({ tree, tmpRoot }), { ok: true });
});

test('cleanup retries transient Windows locks and reports non-retryable errors', async () => {
  const tree = fixtureTree();
  const original = fs.promises.rm;
  let attempts = 0;
  try {
    fs.promises.rm = async (...args) => {
      const code = ['EPERM', 'EBUSY', 'ENOTEMPTY'][attempts++];
      if (code) throw Object.assign(new Error(code), { code });
      return original(...args);
    };
    assert.deepEqual(await removeRoleTree({ tree, tmpRoot }), { ok: true });
    assert.equal(attempts, 4);
    fs.promises.rm = async () => { throw Object.assign(new Error('permission refused'), { code: 'EACCES' }); };
    const result = await removeRoleTree({ tree, tmpRoot });
    assert.equal(result.ok, false);
    assert.match(result.reason, /permission refused/);
  } finally {
    fs.promises.rm = original;
  }
});
