/** Verifies end-to-end copy installation, dry runs, conflicts, idempotency, and exact uninstall. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveHost } from '../../cli/hosts.mjs';
import { install } from '../../cli/install.mjs';
import { buildInstallPlan, readInstallRecord } from '../../cli/manifest.mjs';
import { uninstall } from '../../cli/uninstall.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-install-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return {
    root,
    host: resolveHost({ host: path.join(root, 'host'), codexHome: path.join(root, 'codex-home') }),
  };
}

async function allFiles(root) {
  const found = [];
  try {
    for await (const entry of fs.glob('**', { cwd: root })) {
      if ((await fs.stat(path.join(root, entry))).isFile()) found.push(entry.split(path.sep).join('/'));
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return found.sort();
}

async function backups(host) {
  try {
    return (await fs.readdir(host.root)).filter((name) => name.startsWith('settings.json.codex-bridge-backup-'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function fileHash(target) {
  return createHash('sha256').update(await fs.readFile(target)).digest('hex');
}

test('a rendered file is fingerprinted as written, not as shipped', async (t) => {
  const { host } = await fixture(t);
  await install({ host });
  const record = await readInstallRecord(host);
  const relative = record.files.find((file) => file.endsWith('codex-build.md'));
  const hash = async (target) => createHash('sha256').update(await fs.readFile(target)).digest('hex');
  assert.equal(record.fingerprints[relative], await hash(path.join(host.root, relative)));
  assert.notEqual(record.fingerprints[relative], await hash('src/agents/codex-build.md'));
});

test('install copies the exact plan, expands placeholders, and writes a valid record', async (t) => {
  const { host } = await fixture(t);
  const plan = await buildInstallPlan(host);
  const result = await install({ host });
  assert.equal(result.exitCode, 0);
  const record = await readInstallRecord(host);
  assert.deepEqual(record.files, plan.map((item) => item.relativeToHost));
  assert.deepEqual(Object.keys(record.fingerprints), record.files);
  assert.equal(record.rules.path, path.join(host.codexRulesDir, 'codex-bridge.rules'));
  const rulesBytes = await fs.readFile(record.rules.path);
  assert.deepEqual(rulesBytes, await fs.readFile('src/rules/codex-bridge.rules'));
  assert.equal(record.rules.fingerprint, createHash('sha256').update(rulesBytes).digest('hex'));
  const installed = await allFiles(host.root);
  for (const file of record.files) assert.ok(installed.includes(file), file);
  await fs.access(path.join(host.agentsDir, '.codex-bridge-install.json'));
  assert.ok(installed.includes('settings.json'));
  for (const item of plan.filter((entry) => entry.processing === 'placeholders')) {
    const content = await fs.readFile(item.target, 'utf8');
    const source = await fs.readFile(item.source, 'utf8');
    assert.equal(record.fingerprints[item.relativeToHost], createHash('sha256').update(content).digest('hex'));
    assert.doesNotMatch(content, /\{\{CODEX_BRIDGE_DIR\}\}/);
    if (source.includes('{{CODEX_BRIDGE_DIR}}')) {
      assert.ok(content.includes(host.agentsDir.replaceAll('\\', '/')));
      assert.notEqual(record.fingerprints[item.relativeToHost], createHash('sha256').update(source).digest('hex'));
    }
  }
});

test('install upgrades a legacy record with host fingerprints', async (t) => {
  const { host } = await fixture(t);
  await install({ host });
  const recordPath = path.join(host.agentsDir, '.codex-bridge-install.json');
  const legacy = JSON.parse(await fs.readFile(recordPath, 'utf8'));
  delete legacy.fingerprints;
  await fs.writeFile(recordPath, `${JSON.stringify(legacy, null, 2)}\n`);
  const result = await install({ host });
  assert.equal(result.exitCode, 0);
  assert.doesNotMatch(result.output, /nothing to do/);
  const upgraded = await readInstallRecord(host);
  assert.deepEqual(Object.keys(upgraded.fingerprints), upgraded.files);
  for (const file of upgraded.files) {
    const content = await fs.readFile(path.join(host.root, file));
    assert.equal(upgraded.fingerprints[file], createHash('sha256').update(content).digest('hex'));
  }
});

test('second install is a complete no-op with unchanged mtimes and no new backup', async (t) => {
  const { host } = await fixture(t);
  await fs.mkdir(host.root, { recursive: true });
  await fs.writeFile(host.settingsPath, JSON.stringify({ model: 'test' }));
  await install({ host });
  const recordPath = path.join(host.agentsDir, '.codex-bridge-install.json');
  const before = {
    record: (await fs.stat(recordPath)).mtimeMs,
    settings: (await fs.stat(host.settingsPath)).mtimeMs,
    backups: await backups(host),
  };
  const result = await install({ host });
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /nothing to do/);
  assert.equal((await fs.stat(recordPath)).mtimeMs, before.record);
  assert.equal((await fs.stat(host.settingsPath)).mtimeMs, before.settings);
  assert.deepEqual(await backups(host), before.backups);
});

test('dry-run reports actions without creating the host, files, directories, or backups', async (t) => {
  const { host } = await fixture(t);
  const result = await install({ host, dryRun: true });
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /Would create/);
  await assert.rejects(() => fs.access(host.root), { code: 'ENOENT' });
});

test('unrecorded conflict fails untouched and --force overwrites it', async (t) => {
  const { host } = await fixture(t);
  const plan = await buildInstallPlan(host);
  const conflict = plan[0];
  await fs.mkdir(path.dirname(conflict.target), { recursive: true });
  await fs.writeFile(conflict.target, 'foreign');
  const refused = await install({ host });
  assert.equal(refused.exitCode, 1);
  assert.match(refused.output, new RegExp(conflict.relativeToHost.replaceAll('/', '[\\\\/]')));
  assert.match(refused.output, /--force/);
  assert.equal(await fs.readFile(conflict.target, 'utf8'), 'foreign');
  assert.equal(await readInstallRecord(host), null);
  assert.equal((await install({ host, force: true })).exitCode, 0);
  assert.notEqual(await fs.readFile(conflict.target, 'utf8'), 'foreign');
});

test('a foreign rules file conflicts unless --force replaces it', async (t) => {
  const { host } = await fixture(t);
  const target = path.join(host.codexRulesDir, 'codex-bridge.rules');
  await fs.mkdir(host.codexRulesDir, { recursive: true });
  await fs.writeFile(target, 'foreign rules');
  const refused = await install({ host });
  assert.equal(refused.exitCode, 1);
  assert.match(refused.output, /codex-bridge\.rules/);
  assert.match(refused.output, /--force/);
  assert.equal(await fs.readFile(target, 'utf8'), 'foreign rules');
  assert.equal((await install({ host, force: true })).exitCode, 0);
  assert.deepEqual(await fs.readFile(target), await fs.readFile('src/rules/codex-bridge.rules'));
});

test('recorded manual changes conflict instead of being overwritten', async (t) => {
  const { host } = await fixture(t);
  const plan = await buildInstallPlan(host);
  await install({ host });
  const changed = plan[0];
  await fs.writeFile(changed.target, 'manual change');
  const refused = await install({ host });
  assert.equal(refused.exitCode, 1);
  assert.match(refused.output, /Conflicting files/);
  assert.equal(await fs.readFile(changed.target, 'utf8'), 'manual change');
});

test('install restores a missing recorded rules file instead of reporting a no-op', async (t) => {
  const { host } = await fixture(t);
  await install({ host });
  const record = await readInstallRecord(host);
  await fs.rm(record.rules.path);
  const restored = await install({ host });
  assert.equal(restored.exitCode, 0);
  assert.doesNotMatch(restored.output, /nothing to do/);
  assert.deepEqual(await fs.readFile(record.rules.path), await fs.readFile('src/rules/codex-bridge.rules'));
  assert.equal((await readInstallRecord(host)).rules.fingerprint, await fileHash(record.rules.path));
});

test('invalid settings aborts before copying any package file', async (t) => {
  const { host } = await fixture(t);
  await fs.mkdir(host.root, { recursive: true });
  await fs.writeFile(host.settingsPath, '{ broken');
  await assert.rejects(() => install({ host }), /cannot parse/);
  assert.equal(await fs.readFile(host.settingsPath, 'utf8'), '{ broken');
  assert.deepEqual(await allFiles(host.root), ['settings.json']);
});

test('uninstall removes only recorded files and hook while preserving foreign hook, files, and runs', async (t) => {
  const { host } = await fixture(t);
  await fs.mkdir(host.root, { recursive: true });
  await fs.writeFile(host.settingsPath, JSON.stringify({
    hooks: { SubagentStop: [{ matcher: '*', hooks: [{ type: 'command', command: 'dacapo hook claude' }] }] },
  }));
  await install({ host });
  const foreign = path.join(host.agentsDir, 'foreign.txt');
  const run = path.join(host.root, 'codex-runs', 'run.json');
  await fs.writeFile(foreign, 'keep');
  await fs.mkdir(path.dirname(run), { recursive: true });
  await fs.writeFile(run, 'keep');
  const result = await uninstall({ host });
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /artifacts.*preserved/i);
  assert.equal(await fs.readFile(foreign, 'utf8'), 'keep');
  assert.equal(await fs.readFile(run, 'utf8'), 'keep');
  assert.equal(await readInstallRecord(host), null);
  const settings = JSON.parse(await fs.readFile(host.settingsPath, 'utf8'));
  assert.deepEqual(settings.hooks.SubagentStop[0].hooks, [{ type: 'command', command: 'dacapo hook claude' }]);
  await assert.rejects(() => fs.access(host.commandsDir), { code: 'ENOENT' });
});

test('uninstall removes unchanged bridge rules but preserves adjacent Codex rules', async (t) => {
  const { host } = await fixture(t);
  const defaultRules = path.join(host.codexRulesDir, 'default.rules');
  await fs.mkdir(host.codexRulesDir, { recursive: true });
  await fs.writeFile(defaultRules, 'operator rules');
  await install({ host });
  const bridgeRules = (await readInstallRecord(host)).rules.path;
  assert.equal((await uninstall({ host })).exitCode, 0);
  await assert.rejects(() => fs.access(bridgeRules), { code: 'ENOENT' });
  assert.equal(await fs.readFile(defaultRules, 'utf8'), 'operator rules');
  assert.deepEqual(await fs.readdir(host.codexRulesDir), ['default.rules']);
});

test('uninstall preserves a manually changed rules file and explains why', async (t) => {
  const { host } = await fixture(t);
  await install({ host });
  const rulesPath = (await readInstallRecord(host)).rules.path;
  await fs.writeFile(rulesPath, 'operator change');
  const result = await uninstall({ host });
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /Left .*codex-bridge\.rules.*contents changed/);
  assert.equal(await fs.readFile(rulesPath, 'utf8'), 'operator change');
});

test('uninstall accepts a legacy record without rules metadata', async (t) => {
  const { host } = await fixture(t);
  await install({ host });
  const recordPath = path.join(host.agentsDir, '.codex-bridge-install.json');
  const legacy = JSON.parse(await fs.readFile(recordPath, 'utf8'));
  const rulesPath = legacy.rules.path;
  delete legacy.rules;
  await fs.writeFile(recordPath, `${JSON.stringify(legacy, null, 2)}\n`);
  assert.equal((await uninstall({ host })).exitCode, 0);
  assert.equal(await fs.readFile(rulesPath, 'utf8'), await fs.readFile('src/rules/codex-bridge.rules', 'utf8'));
});

test('uninstall without a record is nonzero and dry-run uninstall changes nothing', async (t) => {
  const absent = await fixture(t);
  const missing = await uninstall({ host: absent.host });
  assert.equal(missing.exitCode, 1);
  assert.match(missing.output, /not installed/);
  await assert.rejects(() => fs.access(absent.host.root), { code: 'ENOENT' });

  const installed = await fixture(t);
  await install({ host: installed.host });
  const before = await allFiles(installed.host.root);
  const dry = await uninstall({ host: installed.host, dryRun: true });
  assert.equal(dry.exitCode, 0);
  assert.match(dry.output, /Would remove/);
  assert.deepEqual(await allFiles(installed.host.root), before);
  assert.equal((await uninstall({ host: installed.host })).exitCode, 0);
  // The agents directory outlives an uninstall by exactly one file: the config the operator
  // owns. Everything the package put there is gone, and the commands directory with it.
  assert.deepEqual(await fs.readdir(installed.host.agentsDir), ['run-config.json']);
  await assert.rejects(() => fs.access(installed.host.commandsDir), { code: 'ENOENT' });
});
