/** Applies Plan_65 D10 host-side inspection and verifies its detachment evidence. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { install } from '../../cli/install.mjs';
import { resolveHost } from '../../cli/hosts.mjs';
import { readInstallRecordFile } from '../../cli/install-record.mjs';
import { inspectHost } from '../../cli/host-inspection.mjs';
import { removeHostSide } from '../../cli/host-removal.mjs';
import { findOwnHooks } from '../../cli/hook-recognizer.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

function fixture(t) {
  const root = makeTempTree('host-removal-');
  t.after(() => removeTempTree(root));
  return resolveHost({
    host: path.join(root, 'host'),
    brandRoot: path.join(root, 'brand'),
    homedir: path.join(root, 'home'),
    codexHome: path.join(root, 'codex'),
  });
}

async function installHost(t) {
  const host = fixture(t);
  const result = await install({ host });
  assert.equal(result.exitCode, 0);
  return host;
}

async function ownEntry(host) {
  const record = await readInstallRecordFile(host);
  return Object.values(record.owners).find((entry) => entry.root === host.root);
}

async function removableBytes(inspection) {
  const bytes = new Map();
  for (const file of inspection.files.filter((entry) => entry.disposition === 'remove')) {
    bytes.set(file.target, await fs.readFile(file.target));
  }
  return bytes;
}

test('removes eligible agent and command files and all own hooks', async (t) => {
  const host = await installHost(t);
  const inspection = await inspectHost(host);
  const removable = inspection.files.filter((file) => file.disposition === 'remove');
  assert.ok(removable.some((file) => file.target.startsWith(host.agentsDir + path.sep)));
  assert.ok(removable.some((file) => file.target.startsWith(host.commandsDir + path.sep)));
  const result = await removeHostSide(host, inspection);
  assert.equal(result.detached, true);
  for (const file of removable) {
    await assert.rejects(fs.access(file.target), { code: 'ENOENT' });
  }
  const settings = JSON.parse(await fs.readFile(host.settingsPath, 'utf8'));
  assert.deepEqual(findOwnHooks(settings, host), []);
});

test('preserves a foreign hook in the same settings group', async (t) => {
  const host = await installHost(t);
  const inspection = await inspectHost(host);
  const own = inspection.hooks[0];
  assert.ok(own);
  const settings = JSON.parse(await fs.readFile(host.settingsPath, 'utf8'));
  const group = settings.hooks[own.event].find((entry) => entry.matcher === own.matcher);
  const foreignCommand = 'node "foreign-hook.mjs"';
  group.hooks.push({ type: 'command', command: foreignCommand });
  await fs.writeFile(host.settingsPath, JSON.stringify(settings, null, 2) + '\n');
  const result = await removeHostSide(host, inspection);
  assert.equal(result.detached, true);
  const updated = JSON.parse(await fs.readFile(host.settingsPath, 'utf8'));
  assert.equal(updated.hooks[own.event].some((entry) => entry.hooks.some((hook) => hook.command === foreignCommand)), true);
  assert.deepEqual(findOwnHooks(updated, host), []);
});

test('leaves edited files and reports their inspection reason', async (t) => {
  const host = await installHost(t);
  const initial = await inspectHost(host);
  const edited = initial.files.find((file) => file.target.startsWith(host.agentsDir + path.sep));
  assert.ok(edited);
  await fs.writeFile(edited.target, 'operator edit');
  const inspection = await inspectHost(host);
  const changed = inspection.files.find((file) => file.target === edited.target);
  const result = await removeHostSide(host, inspection);
  assert.equal(await fs.readFile(edited.target, 'utf8'), 'operator edit');
  assert.ok(result.lines.includes('Left ' + changed.relativeToHost + ' (changed)'));
});

test('dry run reports removals without changing host files or settings bytes', async (t) => {
  const host = await installHost(t);
  const inspection = await inspectHost(host);
  const originalFiles = await removableBytes(inspection);
  const originalSettings = await fs.readFile(host.settingsPath);
  const result = await removeHostSide(host, inspection, { dryRun: true });
  assert.equal(result.detached, true);
  assert.ok(result.lines.some((line) => line.startsWith('Would remove ')));
  for (const file of inspection.files.filter((entry) => entry.disposition === 'remove')) {
    assert.deepEqual(await fs.readFile(file.target), originalFiles.get(file.target));
  }
  assert.deepEqual(await fs.readFile(host.settingsPath), originalSettings);
});

test('does not write unparseable settings and reports the host as not detached', async (t) => {
  const host = await installHost(t);
  await fs.writeFile(host.settingsPath, '{');
  const inspection = await inspectHost(host);
  const removable = inspection.files.filter((file) => file.disposition === 'remove');
  const originalSettings = await fs.readFile(host.settingsPath);
  const result = await removeHostSide(host, inspection);
  assert.equal(result.detached, false);
  assert.ok(result.lines.includes('Left the hooks in ' + host.settingsPath + ': ' + inspection.settingsError));
  // A host that stays attached keeps its files, the old per-host record among them: it may be the
  // only inventory of the image its hooks still point to.
  assert.ok(removable.length > 0);
  for (const file of removable) {
    await assert.doesNotReject(fs.access(file.target));
  }
  assert.deepEqual(await fs.readFile(host.settingsPath), originalSettings);
});

test('uses only the host owner evidence to remove an emptied settings group', async (t) => {
  const ownedHost = await installHost(t);
  const owner = await ownEntry(ownedHost);
  assert.ok(owner);
  const ownedInspection = await inspectHost(ownedHost, { owner });
  const creator = owner.hooks.find((hook) => hook.createdGroup === true);
  assert.ok(creator);
  const foundCreator = ownedInspection.hooks.find((hook) => hook.event === creator.event && hook.command === creator.command);
  assert.ok(foundCreator);
  const ownedResult = await removeHostSide(ownedHost, ownedInspection, { owner });
  assert.equal(ownedResult.detached, true);
  const ownedSettings = JSON.parse(await fs.readFile(ownedHost.settingsPath, 'utf8'));
  assert.equal(ownedSettings.hooks[foundCreator.event].some((group) => group.matcher === foundCreator.matcher), false);
  // A group holding two own hooks, only one of which recorded creating it, must still go once empty.
  for (const groups of Object.values(ownedSettings.hooks)) {
    for (const group of groups) assert.ok(group.hooks.length > 0);
  }

  const unownedHost = await installHost(t);
  const unownedInspection = await inspectHost(unownedHost);
  const firstHook = unownedInspection.hooks[0];
  assert.ok(firstHook);
  await removeHostSide(unownedHost, unownedInspection, { owner: null });
  const unownedSettings = JSON.parse(await fs.readFile(unownedHost.settingsPath, 'utf8'));
  const remainingGroup = unownedSettings.hooks[firstHook.event].find((group) => group.matcher === firstHook.matcher);
  assert.ok(remainingGroup);
  assert.deepEqual(remainingGroup.hooks, []);
});
test('catches hook removal errors and continues through every hook', async (t) => {
  const host = await installHost(t);
  const inspection = await inspectHost(host);
  assert.ok(inspection.hooks.length > 1);
  await fs.writeFile(host.settingsPath, '{');
  const originalSettings = await fs.readFile(host.settingsPath);
  const result = await removeHostSide(host, inspection);
  assert.equal(result.detached, false);
  const failures = result.lines.filter((line) => line.startsWith('Failed to remove the '));
  assert.equal(failures.length, inspection.hooks.length);
  for (const hook of inspection.hooks) {
    const identity = hook.name ?? hook.command;
    const prefix = 'Failed to remove the ' + hook.event + ' hook ' + identity + ': ';
    assert.ok(failures.some((line) => line.startsWith(prefix)));
  }
  assert.deepEqual(await fs.readFile(host.settingsPath), originalSettings);
});