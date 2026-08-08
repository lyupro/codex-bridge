/** Covers BOM-tolerant command reads and the Plan_24 settings backup scope. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveHost } from '../../cli/hosts.mjs';
import { diagnose } from '../../cli/doctor.mjs';
import { install } from '../../cli/install.mjs';
import { packageInfo } from '../../cli/manifest.mjs';
import { permissions } from '../../cli/permissions.mjs';
import { uninstall } from '../../cli/uninstall.mjs';
import { update } from '../../cli/update.mjs';

async function fixture(t, name) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-json-command-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return {
    root,
    host: resolveHost({
      host: path.join(root, name),
      codexHome: path.join(root, 'codex-home'),
    }),
  };
}

async function writeSettings(host, settings, bom = false) {
  await fs.mkdir(host.root, { recursive: true });
  const prefix = bom ? '\uFEFF' : '';
  await fs.writeFile(host.settingsPath, prefix + JSON.stringify(settings) + '\n');
}

async function backups(host) {
  return (await fs.readdir(host.root))
    .filter((name) => name.startsWith('settings.json.codex-bridge-backup-'));
}

const codexProbe = () => ({ available: true, value: 'codex-cli test' });

test('install, update, doctor, permissions, and uninstall read BOM settings', async (t) => {
  const { host } = await fixture(t, 'host');
  await writeSettings(host, { custom: 'keep' }, true);

  assert.equal((await install({ host })).exitCode, 0);
  await writeSettings(host, JSON.parse(await fs.readFile(host.settingsPath, 'utf8')), true);

  assert.equal((await update({ host })).exitCode, 0);
  const diagnosis = await diagnose({
    host,
    codexProbe,
    currentPackage: await packageInfo(),
  });
  assert.equal(diagnosis.exitCode, 0);
  assert.equal((await permissions({ host })).exitCode, 0);
  assert.equal((await permissions({ host, action: 'add' })).exitCode, 0);
  assert.equal((await uninstall({ host })).exitCode, 0);
});

test('uninstall writes one backup for four hooks and permission rules', async (t) => {
  const { host } = await fixture(t, 'host');
  await writeSettings(host, { custom: 'keep' });
  await install({ host });
  await permissions({ host, action: 'add' });
  const before = await backups(host);

  const result = await uninstall({ host });

  assert.equal(result.exitCode, 0);
  assert.equal((await backups(host)).length, before.length + 1);
  const finalSettings = JSON.parse(await fs.readFile(host.settingsPath, 'utf8'));
  assert.equal(finalSettings.custom, 'keep');
  assert.deepEqual(finalSettings.hooks?.PreToolUse, []);
  assert.deepEqual(finalSettings.hooks?.SubagentStop, []);
  assert.deepEqual(finalSettings.permissions?.allow, []);
  assert.deepEqual(finalSettings.permissions?.deny, []);
});

test('two independent command runs each write their own backup', async (t) => {
  const first = await fixture(t, 'first');
  const second = await fixture(t, 'second');
  await writeSettings(first.host, {});
  await writeSettings(second.host, {});

  await Promise.all([
    permissions({ host: first.host, action: 'add' }),
    permissions({ host: second.host, action: 'add' }),
  ]);

  assert.equal((await backups(first.host)).length, 1);
  assert.equal((await backups(second.host)).length, 1);
});
