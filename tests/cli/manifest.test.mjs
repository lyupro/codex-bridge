/** Verifies install planning, placeholder expansion, and installation record validation. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveHost } from '../../cli/hosts.mjs';
import {
  INSTALL_TABLE,
  SEEDED_SOURCES,
  buildInstallPlan,
  fileFingerprint,
  readInstallRecord,
  replacePlaceholders,
  rulesPlan,
  seedPlan,
  validateInstallRecord,
  writeInstallRecord,
} from '../../cli/manifest.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-manifest-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, 'package');
  const host = resolveHost({
    host: path.join(root, 'host'),
    codexHome: path.join(root, 'codex-home'),
    brandRoot: path.join(root, 'brand'),
  });
  await fs.mkdir(path.join(packageRoot, 'src', 'agents'), { recursive: true });
  await fs.mkdir(path.join(packageRoot, 'src', 'commands'), { recursive: true });
  await fs.mkdir(path.join(packageRoot, 'src', 'hooks'), { recursive: true });
  await fs.mkdir(path.join(packageRoot, 'src', 'rules'), { recursive: true });
  await fs.writeFile(path.join(packageRoot, 'src', 'agents', 'build.md'), 'agent');
  await fs.writeFile(path.join(packageRoot, 'src', 'agents', 'notes.txt'), 'notes');
  await fs.writeFile(path.join(packageRoot, 'src', 'commands', 'env.md'), 'command');
  await fs.writeFile(path.join(packageRoot, 'src', 'hooks', 'guard.mjs'), 'guard');
  await fs.writeFile(path.join(packageRoot, 'src', 'rules', 'codex-bridge.rules'), 'rules');
  return { root, packageRoot, host };
}

const record = {
  name: '@lyupro/codex-bridge',
  version: '0.1.0',
  installedAt: '2026-08-02T10:00:00.000Z',
  mode: 'copy',
  files: [
    { root: 'claude', path: 'agents/codex/run-codex.mjs' },
    { root: 'claude', path: 'agents/codex/hooks/reply-guard.mjs' },
  ],
  hooks: [{ event: 'SubagentStop', root: 'claude', path: 'agents/codex/hooks/reply-guard.mjs' }],
};

test('installation table is exported data', () => {
  assert.deepEqual(INSTALL_TABLE, [
    { source: 'src/agents/*.md', root: 'claude', target: 'agentsDir', processing: 'placeholders' },
    { source: 'src/commands/*.md', root: 'claude', target: 'commandsDir', processing: 'placeholders' },
    { source: 'src/hooks/**', root: 'brand', target: 'brandHooksDir', processing: 'copy' },
    { source: 'src/**', root: 'brand', target: 'brandRunnerDir', processing: 'copy' },
  ]);
});

test('seed plan includes the editable host conventions beside run-config', async (t) => {
  const { packageRoot, host } = await fixture(t);
  await fs.writeFile(path.join(packageRoot, 'src', 'run-config.json'), '{}\n');
  await fs.writeFile(path.join(packageRoot, 'src', 'conventions.md'), '# conventions\n');

  assert.deepEqual(SEEDED_SOURCES, ['src/run-config.json', 'src/conventions.md']);
  assert.deepEqual(seedPlan(host, packageRoot).map((item) => ({
    source: path.relative(packageRoot, item.source).split(path.sep).join('/'),
    target: path.relative(host.brandRoot, item.target).split(path.sep).join('/'),
    processing: item.processing,
  })), [
    { source: 'src/run-config.json', target: 'config.json', processing: 'copy' },
    { source: 'src/conventions.md', target: 'conventions.md', processing: 'copy' },
  ]);
});

test('install plan maps agents, commands, and remaining src files', async (t) => {
  const { packageRoot, host } = await fixture(t);
  const plan = await buildInstallPlan(host, packageRoot);
  assert.deepEqual(plan.map((item) => item.relativeToRoot), [
    'hooks/guard.mjs',
    'lib/agents/notes.txt',
    'agents/codex/build.md',
    'commands/codex/env.md',
  ]);
  assert.deepEqual(plan.map((item) => item.processing), ['copy', 'copy', 'placeholders', 'placeholders']);
  assert.deepEqual(rulesPlan(host, packageRoot), {
    source: path.join(packageRoot, 'src', 'rules', 'codex-bridge.rules'),
    target: path.join(host.codexRulesDir, 'codex-bridge.rules'),
    name: 'codex-bridge.rules',
  });
});

test('placeholder becomes an absolute POSIX agents path', () => {
  const agentsDir = path.resolve('C:\\fixture\\host\\agents\\codex');
  const replaced = replacePlaceholders('node "{{CODEX_BRIDGE_DIR}}/run.mjs"', agentsDir);
  assert.equal(replaced, `node "${agentsDir.split(path.sep).join('/')}/run.mjs"`);
  assert.doesNotMatch(replaced, /\{\{CODEX_BRIDGE_DIR\}\}/);
});

test('installation record writes and reads after validation', async (t) => {
  const { host } = await fixture(t);
  await fs.mkdir(host.brandRoot, { recursive: true });
  await writeInstallRecord(host, record);
  assert.deepEqual(await readInstallRecord(host), record);
});

test('installation record migrates an old single-hook record on read', async (t) => {
  const { host } = await fixture(t);
  const legacy = { ...record, hooks: undefined };
  delete legacy.hooks;
  legacy.hook = { event: 'SubagentStop', path: 'agents/codex/hooks/reply-guard.mjs' };
  await fs.mkdir(host.agentsDir, { recursive: true });
  await fs.writeFile(path.join(host.agentsDir, '.codex-bridge-install.json'), `${JSON.stringify(legacy)}\n`);
  const migrated = await readInstallRecord(host);
  assert.deepEqual(migrated.hooks, [{ ...legacy.hook, root: 'claude' }]);
  assert.equal(migrated.hook, undefined);
});

test('file fingerprint hashes bytes and returns null for a missing file', async (t) => {
  const { root } = await fixture(t);
  const target = path.join(root, 'fingerprint.txt');
  await fs.writeFile(target, 'host content');
  assert.equal(await fileFingerprint(target), 'c7356824c7966d281232a8fb0b0bc8c056a3c6d666b55b3db1efc5db4588f98c');
  assert.equal(await fileFingerprint(path.join(root, 'missing.txt')), null);
});

test('installation record without fingerprints remains valid', () => {
  assert.equal(validateInstallRecord(record), record);
});

test('installation record validates multiple hooks sharing one event by filename', () => {
  const multiHook = {
    ...record,
    files: [
      ...record.files,
      { root: 'claude', path: 'agents/codex/hooks/order-gate.mjs' },
      { root: 'claude', path: 'agents/codex/hooks/worktree-lock.mjs' },
    ],
    hooks: [
      ...record.hooks,
      { event: 'PreToolUse', root: 'claude', path: 'agents/codex/hooks/order-gate.mjs' },
      { event: 'PreToolUse', root: 'claude', path: 'agents/codex/hooks/worktree-lock.mjs' },
    ],
  };
  assert.equal(validateInstallRecord(multiHook), multiHook);
});

test('installation record accepts an optional absolute rules fingerprint', () => {
  const withRules = {
    ...record,
    rules: { path: path.resolve('codex-home', 'rules', 'codex-bridge.rules'), fingerprint: 'a'.repeat(64) },
  };
  assert.equal(validateInstallRecord(withRules), withRules);
  assert.equal(validateInstallRecord(record), record);
});

test('installation record rejects malformed rules metadata', () => {
  assert.throws(() => validateInstallRecord({ ...record, rules: 'rules' }), /rules must be an object/);
  assert.throws(() => validateInstallRecord({
    ...record,
    rules: { path: path.resolve('rules', 'foreign.rules'), fingerprint: 'a'.repeat(64) },
  }), /rules path must name codex-bridge\.rules/);
  assert.throws(() => validateInstallRecord({
    ...record,
    rules: { path: path.resolve('rules', 'codex-bridge.rules'), fingerprint: 'not-hex' },
  }), /rules fingerprint must be a 64-character hexadecimal/);
});

test('installation record rejects an extra fingerprint key', () => {
  const fingerprints = Object.fromEntries(record.files.map((file) => [file.path, 'a'.repeat(64)]));
  fingerprints['agents/codex/extra.mjs'] = 'b'.repeat(64);
  assert.throws(() => validateInstallRecord({ ...record, fingerprints }), /fingerprints keys must exactly match files/);
});

test('installation record rejects a missing fingerprint key', () => {
  const fingerprints = { [record.files[0].path]: 'a'.repeat(64) };
  assert.throws(() => validateInstallRecord({ ...record, fingerprints }), /fingerprints keys must exactly match files/);
});

test('installation record rejects malformed fingerprint values', () => {
  const fingerprints = Object.fromEntries(record.files.map((file) => [file.path, 'a'.repeat(64)]));
  assert.throws(() => validateInstallRecord({ ...record, fingerprints: { ...fingerprints, [record.files[0].path]: 'not-hex' } }), /64-character hexadecimal/);
  assert.throws(() => validateInstallRecord({ ...record, fingerprints: { ...fingerprints, [record.files[0].path]: 'a'.repeat(63) } }), /64-character hexadecimal/);
});

test('missing record reads as not installed', async (t) => {
  const { host } = await fixture(t);
  assert.equal(await readInstallRecord(host), null);
});

test('malformed and structurally broken records fail loudly', async (t) => {
  const { host } = await fixture(t);
  await fs.mkdir(host.agentsDir, { recursive: true });
  await fs.writeFile(path.join(host.agentsDir, '.codex-bridge-install.json'), '{ nope');
  await assert.rejects(() => readInstallRecord(host), /invalid installation record JSON/);
  assert.throws(() => validateInstallRecord({ ...record, files: [3] }), /files/);
  assert.throws(() => validateInstallRecord({ ...record, files: [] }), /non-empty list/);
  assert.throws(() => validateInstallRecord({ ...record, files: ['.'] }), /installation root/);
  assert.throws(() => validateInstallRecord({ ...record, files: ['../outside.mjs'] }), /installation root/);
  assert.throws(() => validateInstallRecord({ ...record, hooks: null }), /hooks/);
  assert.throws(() => validateInstallRecord({ ...record, hooks: [{ event: 'SubagentStop', root: 'claude', path: record.files[0].path }] }), /reply-guard/);
  assert.throws(() => validateInstallRecord({ ...record, hooks: [{ event: 'Unknown', root: 'claude', path: record.files[1].path }] }), /supported event/);
});
