/** Verifies D7 applies only eligible owners' files and hooks before advancing their record rows. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import { normalizeRepoPath } from '../../src/home/lib/runner/project-dir.mjs';
import { resolveHost } from '../../cli/hosts.mjs';
import { install } from '../../cli/install.mjs';
import { buildInstallPlan, fileFingerprint, PACKAGE_ROOT } from '../../cli/manifest.mjs';
import { readInstallRecordFile } from '../../cli/install-record.mjs';
import { hookTargets } from '../../cli/hook-targets.mjs';
import { plannedContent } from '../../cli/copy.mjs';
import { ownerSyncLines, planOwnerSync } from '../../cli/owner-sync.mjs';
import { applyOwnerSync, ownerApplyLines } from '../../cli/owner-sync-apply.mjs';

const env = { PATH: '' };
const key = (host) => normalizeRepoPath(host.root);
const rowBytes = (record, host) => JSON.stringify(record.owners[key(host)]);

async function fixture(t, third = false) {
  const dir = makeTempTree('owner-sync-apply-');
  t.after(() => removeTempTree(dir));
  const options = { brandRoot: path.join(dir, 'home'), codexHome: path.join(dir, 'codex') };
  const a = resolveHost({ ...options, host: path.join(dir, 'A') });
  const b = resolveHost({ ...options, host: path.join(dir, 'B') });
  assert.equal((await install({ host: a, env })).exitCode, 0);
  assert.equal((await install({ host: b, env })).exitCode, 0);
  const c = third ? resolveHost({ ...options, host: path.join(dir, 'C') }) : null;
  if (c) assert.equal((await install({ host: c, env })).exitCode, 0);
  const items = (await buildInstallPlan(b)).filter((item) => item.root === 'claude');
  const agent = items.find((item) => item.target.startsWith(b.agentsDir + path.sep));
  return { dir, a, b, c, items, agent, record: await readInstallRecordFile(a) };
}

async function saveRecord(f) {
  await fs.writeFile(f.a.brandInstallRecordPath, JSON.stringify(f.record));
}

async function oldAgent(f, host = f.b) {
  const target = path.join(host.root, f.agent.relativeToRoot);
  await fs.writeFile(target, 'Previously installed agent\n');
  const row = f.record.owners[key(host)];
  row.version = '0.1.0';
  row.fingerprints.claude[f.agent.relativeToRoot] = await fileFingerprint(target);
  await saveRecord(f);
}

async function removeHook(f, host = f.b) {
  const target = hookTargets(host, env)[0];
  const settings = JSON.parse(await fs.readFile(host.settingsPath, 'utf8'));
  for (const group of settings.hooks[target.spec.event]) {
    group.hooks = group.hooks.filter((hook) => hook.command !== target.spec.command);
  }
  await fs.writeFile(host.settingsPath, JSON.stringify(settings, null, 2) + '\n');
  return target;
}

async function snapshot(root) {
  const result = {};
  async function visit(target, relative) {
    const stat = await fs.lstat(target);
    result[relative] = { mtime: stat.mtimeMs, directory: stat.isDirectory() };
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(target)).sort()) {
        await visit(path.join(target, name), `${relative}/${name}`);
      }
    } else {
      result[relative].bytes = (await fs.readFile(target)).toString('hex');
    }
  }
  await visit(root, '');
  return result;
}

async function apply(f, options = {}) {
  const plan = await planOwnerSync(f.record, f.a, { env, ...options });
  return applyOwnerSync(plan, f.a, { env, ...options });
}

test('old recorded bytes update and verify before B advances; inventory and A stay byte-identical', async (t) => {
  const f = await fixture(t);
  await oldAgent(f);
  f.record.inventory = 'incomplete';
  f.record.owners[key(f.b)].scope = 'project';
  await saveRecord(f);
  const aBefore = rowBytes(f.record, f.a);
  const inventoryBefore = JSON.stringify(f.record.inventory);
  const hooksBefore = structuredClone(f.record.owners[key(f.b)].hooks);
  const result = await apply(f, { packageRoot: PACKAGE_ROOT });
  const record = await readInstallRecordFile(f.a);
  const replanned = await planOwnerSync(record, f.a, { env });
  assert.equal(result.complete, true);
  assert.deepEqual(result.owners, [{ root: f.b.root, status: 'updated', files: 1, hooks: 0 }]);
  assert.deepEqual(await fs.readFile(f.agent.target), await plannedContent(f.agent, f.b.brandRoot));
  assert.equal(record.owners[key(f.b)].fingerprints.claude[f.agent.relativeToRoot], await fileFingerprint(f.agent.target));
  assert.equal(record.owners[key(f.b)].version, record.image.version);
  assert.equal(record.owners[key(f.b)].scope, 'project');
  assert.deepEqual(record.owners[key(f.b)].hooks, hooksBefore);
  assert.equal(replanned.owners[0].status, 'in-sync');
  assert.equal(rowBytes(record, f.a), aBefore);
  assert.equal(JSON.stringify(record.inventory), inventoryBefore);
});

test('unrecorded absent files are created and added to the verified owner row', async (t) => {
  const f = await fixture(t);
  await fs.unlink(f.agent.target);
  const row = f.record.owners[key(f.b)];
  row.files = row.files.filter((file) => file.path !== f.agent.relativeToRoot);
  delete row.fingerprints.claude[f.agent.relativeToRoot];
  await saveRecord(f);
  const result = await apply(f);
  const record = await readInstallRecordFile(f.a);
  assert.equal(result.complete, true);
  assert.equal(result.owners[0].status, 'updated');
  assert.equal(result.owners[0].files, 1);
  assert.equal(record.owners[key(f.b)].fingerprints.claude[f.agent.relativeToRoot], await fileFingerprint(f.agent.target));
  assert.equal((await planOwnerSync(record, f.a, { env })).owners[0].status, 'in-sync');
});

test('missing hook merges while preserving foreign settings, permissions, seeds and Codex rules', async (t) => {
  const f = await fixture(t);
  await oldAgent(f);
  const target = await removeHook(f);
  const settings = JSON.parse(await fs.readFile(f.b.settingsPath, 'utf8'));
  const foreignHook = { type: 'command', command: 'echo "Operator hook"\n', timeout: 73, operator: true };
  settings.hooks[target.spec.event][0].hooks.push(foreignHook);
  settings.operator = { literal: 'keep "quotes"\n and spacing', nested: [1, false] };
  settings.permissions.deny = ['operator-denied'];
  const permissions = JSON.stringify(settings.permissions);
  const foreignBytes = JSON.stringify(foreignHook);
  const unrelatedBytes = JSON.stringify(settings.operator);
  const allowCount = settings.permissions.allow.length;
  await fs.writeFile(f.b.settingsPath, JSON.stringify(settings, null, 2) + '\n');
  await fs.writeFile(f.a.brandConfigPath, 'Operator config bytes\n');
  await fs.writeFile(f.a.brandConventionsPath, 'Operator conventions bytes\n');
  const configBefore = await fs.readFile(f.a.brandConfigPath);
  const conventionsBefore = await fs.readFile(f.a.brandConventionsPath);
  const rulesBefore = await snapshot(f.a.codexRulesDir);
  const aBefore = rowBytes(f.record, f.a);
  const inventoryBefore = JSON.stringify(f.record.inventory);
  const result = await apply(f);
  const after = JSON.parse(await fs.readFile(f.b.settingsPath, 'utf8'));
  const record = await readInstallRecordFile(f.a);
  const commands = after.hooks[target.spec.event].flatMap((group) => group.hooks);
  assert.equal(result.complete, true);
  assert.deepEqual(result.owners[0], { root: f.b.root, status: 'updated', files: 1, hooks: 1 });
  assert.equal(commands.filter((hook) => hook.command === target.spec.command).length, 1);
  assert.equal(JSON.stringify(commands.find((hook) => hook.operator)), foreignBytes);
  assert.equal(JSON.stringify(after.operator), unrelatedBytes);
  assert.equal(after.permissions.allow.length, allowCount);
  assert.equal(JSON.stringify(after.permissions), permissions);
  assert.deepEqual(await fs.readFile(f.a.brandConfigPath), configBefore);
  assert.deepEqual(await fs.readFile(f.a.brandConventionsPath), conventionsBefore);
  assert.deepEqual(await snapshot(f.a.codexRulesDir), rulesBefore);
  assert.equal(rowBytes(record, f.a), aBefore);
  assert.equal(JSON.stringify(record.inventory), inventoryBefore);
  assert.equal((await planOwnerSync(record, f.a, { env })).owners[0].status, 'in-sync');
});

test('newly created hook groups are recorded and prior createdGroup flags survive unchanged hooks', async (t) => {
  const f = await fixture(t);
  const target = await removeHook(f);
  const settings = JSON.parse(await fs.readFile(f.b.settingsPath, 'utf8'));
  settings.hooks[target.spec.event] = settings.hooks[target.spec.event]
    .filter((group) => group.matcher !== target.spec.matcher);
  await fs.writeFile(f.b.settingsPath, JSON.stringify(settings));
  const row = f.record.owners[key(f.b)];
  const hook = row.hooks.find((entry) => entry.event === target.definition.event && entry.path === target.relative);
  delete hook.createdGroup;
  await saveRecord(f);
  const result = await apply(f);
  const record = await readInstallRecordFile(f.a);
  const updatedHook = record.owners[key(f.b)].hooks.find((entry) => entry.event === target.definition.event
    && entry.path === target.relative);
  assert.equal(result.owners[0].status, 'updated');
  assert.equal(updatedHook.createdGroup, true);
  assert.ok(row.hooks.filter((entry) => entry.createdGroup === true).every((prior) =>
    record.owners[key(f.b)].hooks.find((entry) => entry.event === prior.event
      && entry.path === prior.path).createdGroup === true));
});

test('in-sync owners and an empty plan perform no writes', async (t) => {
  const f = await fixture(t);
  const before = await snapshot(f.dir);
  const result = await apply(f);
  assert.deepEqual(result, { owners: [{ root: f.b.root, status: 'in-sync' }], complete: true });
  assert.deepEqual(await snapshot(f.dir), before);
  assert.deepEqual(await applyOwnerSync({ owners: [] }, f.a), { owners: [], complete: true });
  assert.deepEqual(await snapshot(f.dir), before);
});

test('edited owner conflicts block all its writes even with initiator force and a missing hook', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.agent.target, 'Operator edit\n');
  await removeHook(f);
  const plan = await planOwnerSync(f.record, { ...f.a, force: true }, { env, force: true });
  const before = await snapshot(f.dir);
  const result = await applyOwnerSync(plan, { ...f.a, force: true }, { env, force: true });
  assert.equal(result.complete, false);
  assert.equal(result.owners[0].status, 'conflict');
  assert.deepEqual(result.owners[0], plan.owners[0]);
  assert.deepEqual(await snapshot(f.dir), before);
  assert.equal(rowBytes(await readInstallRecordFile(f.a), f.b), rowBytes(f.record, f.b));
});

test('unreachable owners are carried through without creating their roots', async (t) => {
  const f = await fixture(t);
  await fs.rename(f.b.root, `${f.b.root}-away`);
  const plan = await planOwnerSync(f.record, f.a, { env });
  const before = await snapshot(f.dir);
  const result = await applyOwnerSync(plan, f.a, { env });
  assert.equal(result.complete, false);
  assert.equal(result.owners[0].status, 'unreachable');
  assert.deepEqual(result.owners[0], plan.owners[0]);
  assert.deepEqual(await snapshot(f.dir), before);
  await assert.rejects(fs.lstat(f.b.root), { code: 'ENOENT' });
});

test('a root lost after planning fails without recreating the root or advancing the row', async (t) => {
  const f = await fixture(t);
  await oldAgent(f);
  const plan = await planOwnerSync(f.record, f.a, { env });
  await fs.rename(f.b.root, `${f.b.root}-away`);
  const before = await fs.readFile(f.a.brandInstallRecordPath);
  const result = await applyOwnerSync(plan, f.a, { env });
  assert.equal(result.complete, false);
  assert.equal(result.owners[0].status, 'failed');
  assert.match(result.owners[0].reason, /ENOENT/);
  assert.deepEqual(await fs.readFile(f.a.brandInstallRecordPath), before);
  await assert.rejects(fs.lstat(f.b.root), { code: 'ENOENT' });
});

test('copy failure leaves B row unchanged and still updates the next owner', async (t) => {
  const f = await fixture(t, true);
  await oldAgent(f);
  await oldAgent(f, f.c);
  const plan = await planOwnerSync(f.record, f.a, { env });
  const bBefore = rowBytes(f.record, f.b);
  const aBefore = rowBytes(f.record, f.a);
  const inventoryBefore = JSON.stringify(f.record.inventory);
  await fs.rename(f.b.agentsDir, `${f.b.agentsDir}-away`);
  await fs.writeFile(f.b.agentsDir, 'A file blocks the copy parent\n');
  const result = await applyOwnerSync(plan, f.a, { env });
  const record = await readInstallRecordFile(f.a);
  assert.equal(result.complete, false);
  assert.equal(result.owners[0].status, 'failed');
  assert.match(result.owners[0].reason, /EEXIST|ENOTDIR/);
  assert.equal(rowBytes(record, f.b), bBefore);
  assert.equal(result.owners[1].status, 'updated');
  assert.equal(record.owners[key(f.c)].fingerprints.claude[f.agent.relativeToRoot],
    await fileFingerprint(path.join(f.c.root, f.agent.relativeToRoot)));
  assert.equal(rowBytes(record, f.a), aBefore);
  assert.equal(JSON.stringify(record.inventory), inventoryBefore);
});

test('failed re-planning does not advance B row and does not stop the next owner', async (t) => {
  const f = await fixture(t, true);
  await oldAgent(f);
  await oldAgent(f, f.c);
  const plan = await planOwnerSync(f.record, f.a, { env });
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (source, target) => {
    await rename(source, target);
    if (target === f.agent.target) await fs.writeFile(target, 'Changed before verification\n');
  });
  const result = await applyOwnerSync(plan, f.a, { env });
  const record = await readInstallRecordFile(f.a);
  assert.equal(result.complete, false);
  assert.deepEqual(result.owners[0], { root: f.b.root, status: 'failed', reason: 'verification after the update found conflict' });
  assert.equal(rowBytes(record, f.b), rowBytes(f.record, f.b));
  assert.equal(result.owners[1].status, 'updated');
});

test('hook write failure leaves the entire owner row unchanged', async (t) => {
  const f = await fixture(t);
  await oldAgent(f);
  await removeHook(f);
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (source, target) => {
    if (target === f.b.settingsPath) throw new Error('Hook write denied');
    return rename(source, target);
  });
  const result = await apply(f);
  const record = await readInstallRecordFile(f.a);
  assert.equal(result.complete, false);
  assert.deepEqual(result.owners[0], { root: f.b.root, status: 'failed', reason: 'Hook write denied' });
  assert.equal(rowBytes(record, f.b), rowBytes(f.record, f.b));
  assert.equal(rowBytes(record, f.a), rowBytes(f.record, f.a));
});

test('ownerApplyLines formats each terminal status and reuses planner conflict/unreachable lines', () => {
  const conflict = { root: 'B', status: 'conflict', files: [
    { item: { relativeToRoot: 'agents/edited.md' }, state: 'conflict', reason: 'changed' },
  ] };
  const unreachable = { root: 'C', status: 'unreachable', reason: 'absent' };
  const owners = [
    { root: 'A', status: 'in-sync' },
    { root: 'D', status: 'updated', files: 2, hooks: 3 },
    { root: 'E', status: 'failed', reason: 'Copy failed' },
    conflict,
    unreachable,
  ];
  assert.deepEqual(ownerApplyLines({ owners }), [
    'Updated 2 file(s) and 3 hook(s) of D.',
    'Left E behind: Copy failed; run codex-bridge update --host "E".',
    ...ownerSyncLines({ owners: [conflict, unreachable] }),
  ]);
  assert.deepEqual(ownerApplyLines({ owners: [{ root: 'A', status: 'in-sync' }] }), []);
});
