/** Guards Plan_65 D12 item 7: removal outcomes reflect disk changes, retained data, and D4 links. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { install } from '../../cli/install.mjs';
import { resolveHost } from '../../cli/hosts.mjs';
import { buildHomeRemovalPlan } from '../../cli/home-removal-plan.mjs';
import { executeHomePlan } from '../../cli/home-plan-execute.mjs';
import { imageMembers, installRecordPath, readInstallRecordFile } from '../../cli/install-record.mjs';
import { normalizeRepoPath } from '../../src/home/lib/runner/project-dir.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

const imagePolicy = { remove: true, reason: 'last owner' };
const outcomeAt = (outcomes, relative) => outcomes.find((entry) => entry.relative === relative);

async function installedHome(t) {
  const root = makeTempTree('bridge-home-plan-execute-');
  t.after(() => removeTempTree(root));
  const host = resolveHost({
    host: path.join(root, 'host'),
    codexHome: path.join(root, 'codex-home'),
    brandRoot: path.join(root, 'home'),
  });
  await install({ host });
  const record = await readInstallRecordFile(host);
  const members = imageMembers(record, host).filter((file) => file.root === 'brand').map((file) => file.path);
  return { root, host, members };
}

function removalPlan(host, policy = imagePolicy) {
  return buildHomeRemovalPlan({ command: 'uninstall', host, imagePolicy: policy });
}

async function snapshot(root) {
  const entries = [];
  const walk = async (relative) => {
    const target = path.join(root, relative);
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) {
      entries.push({ relative, kind: 'link', target: await fs.readlink(target) });
    } else if (stat.isDirectory()) {
      entries.push({ relative, kind: 'directory' });
      for (const name of (await fs.readdir(target)).sort()) {
        await walk(relative ? `${relative}/${name}` : name);
      }
    } else {
      entries.push({ relative, kind: 'file', bytes: await fs.readFile(target) });
    }
  };
  await walk('');
  return entries;
}

test('detached last owner removes image and record, keeps config and root, in execution order', async (t) => {
  const { host, members } = await installedHome(t);
  const plan = await removalPlan(host);
  assert.equal(plan.command, 'uninstall');
  const { outcomes } = await executeHomePlan(host, plan, { detached: true, imageMembers: members });
  assert.ok(members.length > 0);
  for (const relative of members) {
    assert.equal(outcomeAt(outcomes, relative).result, 'removed');
    assert.equal(outcomeAt(outcomes, relative).lane, 'home');
    await assert.rejects(fs.lstat(path.join(host.brandRoot, relative)), { code: 'ENOENT' });
  }
  assert.equal(outcomeAt(outcomes, '.installed.json').result, 'removed');
  await assert.rejects(fs.lstat(installRecordPath(host)), { code: 'ENOENT' });
  assert.equal(outcomeAt(outcomes, 'config.json').result, 'kept');
  assert.equal(outcomeAt(outcomes, 'config.json').reason, 'purge-only');
  assert.equal((await fs.lstat(host.brandConfigPath)).isFile(), true);
  assert.equal((await fs.lstat(host.brandRoot)).isDirectory(), true);
  assert.equal(outcomeAt(outcomes, ''), undefined);
  assert.equal(outcomeAt(outcomes, 'lib/runner').result, 'removed');
  assert.deepEqual(outcomes.slice(0, plan.rows.length).map((entry) => entry.relative), plan.rows.map((row) => row.relative));
  assert.equal(outcomes[plan.rows.length].relative, '.installed.json');
  const folders = outcomes.slice(plan.rows.length + 1).map((entry) => entry.relative);
  assert.deepEqual(folders, plan.directories.filter((entry) => folders.includes(entry.relative)).map((entry) => entry.relative));
  for (const outcome of outcomes) {
    assert.deepEqual(Object.keys(outcome), ['lane', 'kind', 'id', 'relative', 'result', 'reason']);
    const row = plan.rows.find((entry) => entry.relative === outcome.relative);
    assert.equal(outcome.id, row ? row.id : outcome.relative === '.installed.json' ? 'install-record' : null);
    assert.ok(['removed', 'kept', 'blocked', 'missing', 'failed'].includes(outcome.result));
  }
});

test('an edited image file is kept with its changed reason and bytes', async (t) => {
  const { host, members } = await installedHome(t);
  const relative = members[0];
  const target = path.join(host.brandRoot, relative);
  await fs.appendFile(target, '\noperator edit\n');
  const before = await fs.readFile(target);
  const plan = await removalPlan(host);
  const { outcomes } = await executeHomePlan(host, plan, { detached: true, imageMembers: members });
  assert.equal(outcomeAt(outcomes, relative).result, 'kept');
  assert.equal(outcomeAt(outcomes, relative).reason, 'changed');
  assert.deepEqual(await fs.readFile(target), before);
});

test('an attached host keeps the installation record', async (t) => {
  const { host, members } = await installedHome(t);
  const before = await fs.readFile(installRecordPath(host));
  const plan = await removalPlan(host);
  const { outcomes } = await executeHomePlan(host, plan, { detached: false, imageMembers: members });
  assert.equal(outcomeAt(outcomes, '.installed.json').result, 'kept');
  assert.equal(outcomeAt(outcomes, '.installed.json').reason, 'this host is still attached');
  assert.deepEqual(await fs.readFile(installRecordPath(host)), before);
});

test('other owners keep the shared image and record after the current owner is removed', async (t) => {
  const { root, host, members } = await installedHome(t);
  const other = resolveHost({
    host: path.join(root, 'other-host'),
    codexHome: path.join(root, 'other-codex-home'),
    brandRoot: host.brandRoot,
  });
  await install({ host: other });
  const before = await readInstallRecordFile(host);
  assert.equal(Object.keys(before.owners).length, 2);
  const plan = await removalPlan(host, { remove: false, reason: 'other-owners' });
  const { outcomes } = await executeHomePlan(host, plan, { detached: true, imageMembers: members });
  assert.equal(outcomeAt(outcomes, '.installed.json').result, 'kept');
  assert.equal(outcomeAt(outcomes, '.installed.json').reason, 'this host removed from the record');
  const after = await readInstallRecordFile(host);
  assert.deepEqual(Object.keys(after.owners), [normalizeRepoPath(other.root)]);
  assert.deepEqual(after.owners[normalizeRepoPath(other.root)], before.owners[normalizeRepoPath(other.root)]);
  for (const relative of members) {
    assert.equal(outcomeAt(outcomes, relative).result, 'kept');
    assert.equal(outcomeAt(outcomes, relative).reason, 'other-owners');
    assert.equal((await fs.lstat(path.join(host.brandRoot, relative))).isFile(), true);
  }
});

test('a folder replaced with a junction after planning keeps its files and outside bytes', async (t) => {
  const { root, host, members } = await installedHome(t);
  const plan = await removalPlan(host);
  const relativeFolder = 'lib/runner';
  const moved = members.filter((relative) => relative.startsWith(`${relativeFolder}/`));
  assert.ok(moved.length > 0);
  const folder = path.join(host.brandRoot, relativeFolder);
  const outside = path.join(root, 'outside-runner');
  await fs.rename(folder, outside);
  await fs.symlink(outside, folder, 'junction');
  const before = await snapshot(outside);
  const { outcomes } = await executeHomePlan(host, plan, { detached: true, imageMembers: members });
  for (const relative of moved) {
    assert.equal(outcomeAt(outcomes, relative).result, 'kept');
    assert.equal(outcomeAt(outcomes, relative).reason, `link at ${relativeFolder}`);
  }
  assert.equal(outcomeAt(outcomes, relativeFolder).result, 'kept');
  assert.equal(outcomeAt(outcomes, relativeFolder).reason, `link at ${relativeFolder}`);
  assert.equal((await fs.lstat(folder)).isSymbolicLink(), true);
  assert.deepEqual(await snapshot(outside), before);
});

test('a file deleted after planning is missing and later removals still run', async (t) => {
  const { host, members } = await installedHome(t);
  const plan = await removalPlan(host);
  const relative = members[0];
  await fs.unlink(path.join(host.brandRoot, relative));
  const { outcomes } = await executeHomePlan(host, plan, { detached: true, imageMembers: members });
  assert.equal(outcomeAt(outcomes, relative).result, 'missing');
  assert.equal(outcomeAt(outcomes, relative).reason, 'missing');
  assert.equal(outcomeAt(outcomes, members[1]).result, 'removed');
  assert.equal(outcomeAt(outcomes, '.installed.json').result, 'removed');
});

test('purge refuses without authorization before changing anything', async (t) => {
  const { root, host, members } = await installedHome(t);
  const plan = await buildHomeRemovalPlan({ command: 'purge', host, imagePolicy });
  assert.equal(plan.command, 'purge');
  const before = await snapshot(root);
  await assert.rejects(executeHomePlan(host, plan, { detached: true, imageMembers: members }), { message: 'purge requires its preflight authorization (Plan_65 D12 item 6)' });
  assert.deepEqual(await snapshot(root), before);
});

test('invalid or absent commands fail loud before any changes', async (t) => {
  const { root, host, members } = await installedHome(t);
  const plan = await removalPlan(host);
  const before = await snapshot(root);
  for (const command of ['update', undefined]) {
    await assert.rejects(executeHomePlan(host, { ...plan, command }, { detached: true, imageMembers: members }), TypeError);
  }
  assert.deepEqual(await snapshot(root), before);
});

test('links already present in the plan remain blocked with their plan reasons', async (t) => {
  const { root, host, members } = await installedHome(t);
  const folder = path.join(host.brandRoot, 'lib/runner');
  const outside = path.join(root, 'outside-runner');
  await fs.rename(folder, outside);
  await fs.symlink(outside, folder, 'junction');
  const plan = await removalPlan(host);
  const before = await snapshot(outside);
  const { outcomes } = await executeHomePlan(host, plan, { detached: true, imageMembers: members });
  for (const row of plan.rows.filter((entry) => entry.action === 'blocked')) {
    assert.equal(outcomeAt(outcomes, row.relative).result, 'blocked');
    assert.equal(outcomeAt(outcomes, row.relative).reason, row.reason);
  }
  assert.deepEqual(await snapshot(outside), before);
});

test('a missing record and planned missing files preserve their plan reasons', async (t) => {
  const { host, members } = await installedHome(t);
  await fs.unlink(installRecordPath(host));
  const plan = await removalPlan(host);
  const { outcomes } = await executeHomePlan(host, plan, { detached: true, imageMembers: members });
  assert.equal(outcomeAt(outcomes, '.installed.json').result, 'missing');
  assert.equal(outcomeAt(outcomes, '.installed.json').reason, plan.record.reason);
  for (const row of plan.rows.filter((entry) => entry.action === 'missing')) {
    assert.equal(outcomeAt(outcomes, row.relative).result, 'missing');
    assert.equal(outcomeAt(outcomes, row.relative).reason, row.reason);
  }
});

test('a corrupt record is retained with its plan reason', async (t) => {
  const { host, members } = await installedHome(t);
  await fs.writeFile(installRecordPath(host), '{');
  const plan = await removalPlan(host);
  const { outcomes } = await executeHomePlan(host, plan, { detached: true, imageMembers: members });
  assert.equal(outcomeAt(outcomes, '.installed.json').result, 'kept');
  assert.equal(outcomeAt(outcomes, '.installed.json').reason, plan.record.reason);
  assert.equal(await fs.readFile(installRecordPath(host), 'utf8'), '{');
});

test('the home root is removed only after files, record, and its empty descendants', async (t) => {
  const { host, members } = await installedHome(t);
  await fs.unlink(host.brandConfigPath);
  await fs.unlink(host.brandConventionsPath);
  const plan = await removalPlan(host);
  const { outcomes } = await executeHomePlan(host, plan, { detached: true, imageMembers: members });
  assert.equal(outcomeAt(outcomes, '').result, 'removed');
  assert.equal(outcomes.at(-1).relative, '');
  assert.equal(outcomes[plan.rows.length].relative, '.installed.json');
  await assert.rejects(fs.lstat(host.brandRoot), { code: 'ENOENT' });
});
