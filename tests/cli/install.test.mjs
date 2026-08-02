/** Verifies end-to-end copy installation, dry runs, conflicts, idempotency, and exact uninstall. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveHost } from '../../cli/hosts.mjs';
import { install } from '../../cli/install.mjs';
import { buildInstallPlan, readInstallRecord } from '../../cli/manifest.mjs';
import { uninstall } from '../../cli/uninstall.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-install-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, host: resolveHost({ host: path.join(root, 'host') }) };
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

test('install copies the exact plan, expands placeholders, and writes a valid record', async (t) => {
  const { host } = await fixture(t);
  const plan = await buildInstallPlan(host);
  const result = await install({ host });
  assert.equal(result.exitCode, 0);
  const record = await readInstallRecord(host);
  assert.deepEqual(record.files, plan.map((item) => item.relativeToHost));
  const installed = await allFiles(host.root);
  for (const file of record.files) assert.ok(installed.includes(file), file);
  await fs.access(path.join(host.agentsDir, '.codex-bridge-install.json'));
  assert.ok(installed.includes('settings.json'));
  for (const item of plan.filter((entry) => entry.processing === 'placeholders')) {
    const content = await fs.readFile(item.target, 'utf8');
    const source = await fs.readFile(item.source, 'utf8');
    assert.doesNotMatch(content, /\{\{CODEX_BRIDGE_DIR\}\}/);
    if (source.includes('{{CODEX_BRIDGE_DIR}}')) {
      assert.ok(content.includes(host.agentsDir.replaceAll('\\', '/')));
    }
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
  await assert.rejects(() => fs.access(installed.host.agentsDir), { code: 'ENOENT' });
  await assert.rejects(() => fs.access(installed.host.commandsDir), { code: 'ENOENT' });
});
