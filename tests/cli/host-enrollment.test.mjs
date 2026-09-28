/** Plan_65 D10: verifies owners are recorded only for hosts with package marks. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveHost } from '../../cli/hosts.mjs';
import { install } from '../../cli/install.mjs';
import { findOwnHooks } from '../../cli/hook-recognizer.mjs';
import {
  installRecordPath,
  readInstallRecord,
  recordTarget,
  removeInstallOwner,
} from '../../cli/install-record.mjs';
import { uninstall } from '../../cli/uninstall.mjs';
import { update } from '../../cli/update.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import { formatOneRecord } from './host-fixture.mjs';

function hostsInOneHome(t, name) {
  const root = makeTempTree(`bridge-enrollment-${name}-`);
  t.after(() => removeTempTree(root));
  const brandRoot = path.join(root, 'brand');
  const codexHome = path.join(root, 'codex-home');
  return {
    first: resolveHost({ host: path.join(root, 'host-a'), brandRoot, codexHome }),
    second: resolveHost({ host: path.join(root, 'host-b'), brandRoot, codexHome }),
    third: resolveHost({ host: path.join(root, 'host-c'), brandRoot, codexHome }),
  };
}

async function storedRecord(host) {
  return JSON.parse(await fs.readFile(installRecordPath(host), 'utf8'));
}

function ownerFor(record, host) {
  return Object.values(record.owners).find((owner) => owner.root === host.root);
}

async function ownHookCount(host) {
  const settings = JSON.parse(await fs.readFile(host.settingsPath, 'utf8'));
  return findOwnHooks(settings, host).length;
}

async function marksWithoutOwner(t, name) {
  const hosts = hostsInOneHome(t, name);
  assert.equal((await install({ host: hosts.first })).exitCode, 0);
  assert.equal((await install({ host: hosts.second })).exitCode, 0);
  const secondRecord = await readInstallRecord(hosts.second);
  const agent = secondRecord.files.find((file) => file.root === 'claude' && file.path.startsWith('agents/'));
  assert.ok(agent);
  const agentPath = recordTarget(hosts.second, agent);
  const agentBytes = await fs.readFile(agentPath);
  const hooks = await ownHookCount(hosts.second);
  const before = await storedRecord(hosts.first);
  const firstOwner = ownerFor(before, hosts.first);
  assert.ok(firstOwner);
  const inventory = before.inventory;
  assert.ok(await removeInstallOwner(hosts.second));
  assert.equal(await readInstallRecord(hosts.second), null);
  assert.deepEqual(await fs.readFile(agentPath), agentBytes);
  assert.equal(await ownHookCount(hosts.second), hooks);
  return { ...hosts, agentPath, agentBytes, firstOwner, hooks, inventory };
}

test('install enrolls a marked host without duplicating hooks or changing other owners', async (t) => {
  const { first, second, agentPath, agentBytes, firstOwner, hooks, inventory } = await marksWithoutOwner(t, 'install');

  const result = await install({ host: second });
  const after = await storedRecord(second);

  assert.equal(result.exitCode, 0);
  assert.ok(ownerFor(after, second));
  assert.deepEqual(ownerFor(after, first), firstOwner);
  assert.deepEqual(await fs.readFile(agentPath), agentBytes);
  assert.equal(await ownHookCount(second), hooks);
  assert.equal(after.inventory, inventory);
});

test('install refuses an edited file when enrolling a marked host without a row', async (t) => {
  const { first, second, agentPath, firstOwner, inventory } = await marksWithoutOwner(t, 'conflict');
  const edited = Buffer.from('operator-edited agent file\n', 'utf8');
  await fs.writeFile(agentPath, edited);

  const result = await install({ host: second });
  const after = await storedRecord(first);

  assert.equal(result.exitCode, 1);
  assert.match(result.output, /Conflicting files/);
  assert.equal(await readInstallRecord(second), null);
  assert.deepEqual(await fs.readFile(agentPath), edited);
  assert.deepEqual(ownerFor(after, first), firstOwner);
  assert.equal(after.inventory, inventory);
});

test('update enrolls a marked host and prefixes install output', async (t) => {
  const { second } = await marksWithoutOwner(t, 'update');

  const result = await update({ host: second });

  assert.equal(result.exitCode, 0, result.output);
  const prefix = `No installation record names ${second.root}; recording what is installed.\n`;
  assert.ok(result.output.startsWith(prefix));
  assert.ok(await readInstallRecord(second));
});

test('update without package marks recommends install', async (t) => {
  const { third } = hostsInOneHome(t, 'empty');

  const result = await update({ host: third });

  assert.equal(result.exitCode, 1);
  assert.equal(result.output, 'codex-bridge is not installed. Run codex-bridge install first.');
});

test('uninstall still removes a marked host after its owner row is removed', async (t) => {
  const { first, second, firstOwner } = await marksWithoutOwner(t, 'uninstall');

  const result = await uninstall({ host: second });
  const after = await storedRecord(first);

  assert.equal(result.exitCode, 0);
  assert.doesNotMatch(result.output, /not installed/);
  assert.equal(await readInstallRecord(second), null);
  assert.deepEqual(ownerFor(after, first), firstOwner);
  assert.equal(await ownHookCount(second), 0);
});

test('a non-owner has no view when a format-2 record retains legacy', async (t) => {
  const { first, second, third } = hostsInOneHome(t, 'legacy');
  assert.equal((await install({ host: first })).exitCode, 0);
  const legacy = await formatOneRecord(first);
  await fs.writeFile(installRecordPath(first), `${JSON.stringify(legacy, null, 2)}\n`);
  const prompt = async () => {
    prompt.calls += 1;
    return 'no';
  };
  prompt.calls = 0;

  const result = await install({ host: second, isTTY: true, prompt });
  const after = await storedRecord(first);

  assert.equal(result.exitCode, 0);
  assert.equal(prompt.calls, 1);
  assert.equal(after.format, 2);
  assert.ok(after.legacy);
  assert.equal(await readInstallRecord(third), null);
});