/** Verifies uninstall uses host marks and content evidence (Plan_65 D10). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveHost } from '../../cli/hosts.mjs';
import { install } from '../../cli/install.mjs';
import { findOwnHooks } from '../../cli/hook-recognizer.mjs';
import { installRecordPath, readInstallRecord, recordTarget } from '../../cli/manifest.mjs';
import { uninstall } from '../../cli/uninstall.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

function hostFor(t, name) {
  const root = makeTempTree(`bridge-uninstall-${name}-`);
  t.after(() => removeTempTree(root));
  return resolveHost({
    host: path.join(root, 'host'),
    codexHome: path.join(root, 'codex-home'),
    brandRoot: path.join(root, 'brand'),
  });
}

test('changed agent file is preserved and reported', async (t) => {
  const host = hostFor(t, 'changed-agent');
  await install({ host });
  const record = await readInstallRecord(host);
  const agentFile = record.files.find((file) => {
    const relative = path.relative(host.agentsDir, recordTarget(host, file));
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  });
  assert.ok(agentFile);
  const target = recordTarget(host, agentFile);
  const edited = Buffer.from('operator-edited agent file\n', 'utf8');
  await fs.writeFile(target, edited);
  const result = await uninstall({ host });
  const relative = path.relative(host.root, target).split(path.sep).join('/');
  assert.equal(result.exitCode, 0);
  assert.deepEqual(await fs.readFile(target), edited);
  assert.ok(result.output.includes(`${relative} (changed)`));
});

test('foreign hook in a package hook group survives uninstall', async (t) => {
  const host = hostFor(t, 'foreign-hook');
  await install({ host });
  const settings = JSON.parse(await fs.readFile(host.settingsPath, 'utf8'));
  const own = findOwnHooks(settings, host)[0];
  const group = settings.hooks[own.event][own.groupIndex];
  const foreignCommand = 'foreign hook in a codex-bridge group';
  group.hooks.push({ type: 'command', command: foreignCommand });
  await fs.writeFile(host.settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  const result = await uninstall({ host });
  const after = JSON.parse(await fs.readFile(host.settingsPath, 'utf8'));
  assert.equal(result.exitCode, 0);
  assert.equal(findOwnHooks(after, host).length, 0);
  assert.ok(after.hooks[own.event].some(({ matcher, hooks }) => matcher === own.matcher && hooks.some(({ command }) => command === foreignCommand)));
});

test('unparseable settings block image and record removal without changing settings', async (t) => {
  const host = hostFor(t, 'invalid-settings');
  await install({ host });
  const recordPath = installRecordPath(host);
  const recordBefore = await fs.readFile(recordPath);
  const record = await readInstallRecord(host);
  const imageFiles = record.files.filter((file) => file.root === 'brand');
  const invalidSettings = Buffer.from('{"hooks":[', 'utf8');
  await fs.writeFile(host.settingsPath, invalidSettings);
  const result = await uninstall({ host });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(await fs.readFile(host.settingsPath), invalidSettings);
  assert.deepEqual(await fs.readFile(recordPath), recordBefore);
  for (const file of imageFiles) await assert.doesNotReject(() => fs.access(recordTarget(host, file)));
  assert.match(result.output, /Left the shared image .* because this host's hooks could not be removed/);
  assert.match(result.output, /^Did not finish uninstalling codex-bridge:/);
  assert.doesNotMatch(result.output, /Uninstalled codex-bridge\./);
  for (const file of record.files.filter((entry) => entry.root !== 'brand')) {
    await assert.doesNotReject(() => fs.access(recordTarget(host, file)));
  }
});

test('host marks are cleaned when the installation record is missing', async (t) => {
  const host = hostFor(t, 'missing-record');
  await install({ host });
  const record = await readInstallRecord(host);
  const hostFiles = record.files.filter((file) => file.root !== 'brand');
  const imageFile = record.files.find((file) => file.root === 'brand');
  await fs.unlink(installRecordPath(host));
  const result = await uninstall({ host });
  const settings = JSON.parse(await fs.readFile(host.settingsPath, 'utf8'));
  assert.equal(result.exitCode, 0);
  assert.doesNotMatch(result.output, /codex-bridge is not installed/);
  for (const file of hostFiles) await assert.rejects(() => fs.access(recordTarget(host, file)), { code: 'ENOENT' });
  assert.equal(findOwnHooks(settings, host).length, 0);
  await assert.doesNotReject(() => fs.access(recordTarget(host, imageFile)));
});

test('host with no record or package marks reports not installed', async (t) => {
  const host = hostFor(t, 'empty');
  const result = await uninstall({ host });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /codex-bridge is not installed\./);
});
