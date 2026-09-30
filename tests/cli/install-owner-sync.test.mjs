/** Plan_65 D7: install must synchronize every other recorded owner under its lifecycle lock. */
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
import { imageFingerprint } from '../../cli/install-owners.mjs';
import { hookTargets } from '../../cli/hook-targets.mjs';
import { plannedContent } from '../../cli/copy.mjs';

const env = { PATH: '' };
const key = (host) => normalizeRepoPath(host.root);

async function fixture(t) {
  const root = makeTempTree('install-owner-sync-');
  t.after(() => removeTempTree(root));
  const options = { brandRoot: path.join(root, 'home'), codexHome: path.join(root, 'codex') };
  const a = resolveHost({ ...options, host: path.join(root, 'A') });
  const b = resolveHost({ ...options, host: path.join(root, 'B') });
  assert.equal((await install({ host: a, env })).exitCode, 0);
  const baseline = await install({ host: a, env });
  assert.equal((await install({ host: b, env })).exitCode, 0);
  const plan = await buildInstallPlan(b);
  const agent = plan.find((item) => item.root === 'claude' && item.target.startsWith(b.agentsDir + path.sep));
  assert.ok(agent);
  return { root, a, b, agent, baseline, record: await readInstallRecordFile(a) };
}

async function oldAgent(f) {
  await fs.writeFile(f.agent.target, 'Previously installed agent\n');
  const owner = f.record.owners[key(f.b)];
  owner.version = '0.1.0';
  owner.fingerprints.claude[f.agent.relativeToRoot] = await fileFingerprint(f.agent.target);
  await fs.writeFile(f.a.brandInstallRecordPath, JSON.stringify(f.record, null, 2) + '\n');
  return owner.fingerprints.claude[f.agent.relativeToRoot];
}

async function requireInstall(f) {
  await fs.unlink(path.join(f.a.root, f.agent.relativeToRoot));
}

for (const current of [false, true]) {
  test(`install updates B's recorded old bytes when A is ${current ? 'already current' : 'being installed'}`, async (t) => {
    const f = await fixture(t);
    const before = await oldAgent(f);
    if (!current) await requireInstall(f);
    const result = await install({ host: f.a, env, packageRoot: PACKAGE_ROOT });
    const record = await readInstallRecordFile(f.a);
    assert.equal(result.exitCode, 0);
    assert.ok(result.output.startsWith(current ? 'codex-bridge is already installed; nothing to do.\n' : 'Installed '));
    assert.ok(result.output.includes(`Updated 1 file(s) and 0 hook(s) of ${f.b.root}.`));
    assert.deepEqual(await fs.readFile(f.agent.target), await plannedContent(f.agent, f.b.brandRoot));
    assert.notEqual(record.owners[key(f.b)].fingerprints.claude[f.agent.relativeToRoot], before);
    assert.equal(record.owners[key(f.b)].fingerprints.claude[f.agent.relativeToRoot], await fileFingerprint(f.agent.target));
    assert.equal(record.owners[key(f.b)].version, record.image.version);
    if (current) assert.ok(result.output.startsWith(f.baseline.output + '\n'));
  });

  test(`install leaves B's unrecorded edits behind when A is ${current ? 'already current' : 'being installed'}`, async (t) => {
    const f = await fixture(t);
    const edited = 'Operator-edited agent\n';
    await fs.writeFile(f.agent.target, edited);
    if (!current) await requireInstall(f);
    const result = await install({ host: f.a, env });
    const record = await readInstallRecordFile(f.a);
    assert.equal(result.exitCode, 1);
    assert.ok(result.output.startsWith(current ? 'codex-bridge is already installed; nothing to do.\n' : 'Installed '));
    assert.ok(result.output.includes(`Left ${f.b.root} behind: ${f.agent.relativeToRoot} (changed)`));
    assert.equal(await fs.readFile(f.agent.target, 'utf8'), edited);
    assert.deepEqual(record.owners[key(f.b)], f.record.owners[key(f.b)]);
    assert.deepEqual(await fs.readFile(path.join(f.a.root, f.agent.relativeToRoot)), await plannedContent(f.agent, f.b.brandRoot));
  });

  test(`install does not recreate absent B when A is ${current ? 'already current' : 'being installed'}`, async (t) => {
    const f = await fixture(t);
    await fs.rename(f.b.root, path.join(f.root, 'B-away'));
    if (!current) await requireInstall(f);
    const result = await install({ host: f.a, env });
    assert.equal(result.exitCode, 1);
    assert.ok(result.output.includes(`Left ${f.b.root} behind: absent`));
    await assert.rejects(fs.access(f.b.root), { code: 'ENOENT' });
    assert.deepEqual((await readInstallRecordFile(f.a)).owners[key(f.b)], f.record.owners[key(f.b)]);
  });

  test(`dry run only plans B's update when A is ${current ? 'already current' : 'being installed'}`, async (t) => {
    const f = await fixture(t);
    await oldAgent(f);
    if (!current) await requireInstall(f);
    const before = await Promise.all([fs.readFile(f.agent.target), fs.readFile(f.a.brandInstallRecordPath), fs.readFile(f.b.settingsPath)]);
    const result = await install({ host: f.a, env, dryRun: true });
    const after = await Promise.all([fs.readFile(f.agent.target), fs.readFile(f.a.brandInstallRecordPath), fs.readFile(f.b.settingsPath)]);
    assert.equal(result.exitCode, 0);
    assert.ok(result.output.includes(`Would update 1 file(s) and 0 hook(s) of ${f.b.root}.`));
    assert.doesNotMatch(result.output, /Updated 1 file/);
    assert.deepEqual(after, before);
    if (current) assert.equal(result.output.split('\n')[0], 'codex-bridge is already installed; nothing to do.');
    else await assert.rejects(fs.access(path.join(f.a.root, f.agent.relativeToRoot)), { code: 'ENOENT' });
  });
}

test('--force on A cannot overwrite or advance edited B', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.a.root, f.agent.relativeToRoot), 'Edited initiator\n');
  await fs.writeFile(f.agent.target, 'Edited other owner\n');
  const result = await install({ host: f.a, env, force: true });
  assert.equal(result.exitCode, 1);
  assert.ok(result.output.startsWith('Installed '));
  assert.ok(result.output.includes(`Left ${f.b.root} behind: ${f.agent.relativeToRoot} (changed)`));
  assert.equal(await fs.readFile(f.agent.target, 'utf8'), 'Edited other owner\n');
  assert.deepEqual(await fs.readFile(path.join(f.a.root, f.agent.relativeToRoot)), await plannedContent(f.agent, f.b.brandRoot));
  assert.deepEqual((await readInstallRecordFile(f.a)).owners[key(f.b)], f.record.owners[key(f.b)]);
});

test('current A and B keep the existing no-op output byte-identical and do not rewrite the record', async (t) => {
  const f = await fixture(t);
  const before = await fs.readFile(f.a.brandInstallRecordPath);
  const beforeMtime = (await fs.stat(f.a.brandInstallRecordPath)).mtimeMs;
  const result = await install({ host: f.a, env });
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, f.baseline.output);
  assert.equal(result.output.split('\n')[0], 'codex-bridge is already installed; nothing to do.');
  assert.deepEqual(await fs.readFile(f.a.brandInstallRecordPath), before);
  assert.equal((await fs.stat(f.a.brandInstallRecordPath)).mtimeMs, beforeMtime);
});

test('nested install syncs B once after writing A without asking a transition question', async (t) => {
  const f = await fixture(t);
  f.record.inventory = 'incomplete';
  await oldAgent(f);
  const result = await install({
    host: f.a, env,
    inventoryTransition: { transition: true, homeHadImage: true, inventory: 'incomplete' },
    isTTY: true,
    prompt: async () => assert.fail('nested install asked a transition question'),
  });
  assert.equal(result.exitCode, 0);
  assert.ok(result.output.startsWith('Installed '));
  assert.equal(result.output.split(`Updated 1 file(s) and 0 hook(s) of ${f.b.root}.`).length - 1, 1);
  assert.deepEqual(await fs.readFile(f.agent.target), await plannedContent(f.agent, f.b.brandRoot));
  assert.equal((await readInstallRecordFile(f.a)).inventory, 'incomplete');
});

test('install restores a missing B hook without granting permissions or replacing operator seeds', async (t) => {
  const f = await fixture(t);
  await oldAgent(f);
  const target = hookTargets(f.b, env)[0];
  const settings = JSON.parse(await fs.readFile(f.b.settingsPath, 'utf8'));
  for (const group of settings.hooks[target.spec.event]) {
    group.hooks = group.hooks.filter((hook) => hook.command !== target.spec.command);
  }
  settings.permissions.allow = [];
  settings.operatorSetting = 'keep me';
  await fs.writeFile(f.b.settingsPath, JSON.stringify(settings, null, 2) + '\n');
  await fs.writeFile(f.b.brandConventionsPath, 'Operator conventions\n');
  const protectedPaths = [f.b.brandConventionsPath, f.b.brandConfigPath, path.join(f.b.codexRulesDir, 'codex-bridge.rules')];
  const before = await Promise.all(protectedPaths.map((file) => fs.readFile(file)));
  const result = await install({ host: f.a, env });
  const after = JSON.parse(await fs.readFile(f.b.settingsPath, 'utf8'));
  assert.equal(result.exitCode, 0);
  assert.ok(result.output.includes(`Updated 1 file(s) and 1 hook(s) of ${f.b.root}.`));
  assert.ok(after.hooks[target.spec.event].some((group) => group.hooks.some((hook) => hook.command === target.spec.command)));
  assert.deepEqual(after.permissions, settings.permissions);
  assert.equal(after.operatorSetting, settings.operatorSetting);
  assert.deepEqual(await Promise.all(protectedPaths.map((file) => fs.readFile(file))), before);
});

test('dry run reports a conflicting B and still exits zero without writes', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.agent.target, 'Edited B\n');
  const before = await fs.readFile(f.a.brandInstallRecordPath);
  const result = await install({ host: f.a, env, dryRun: true });
  assert.equal(result.exitCode, 0);
  assert.ok(result.output.includes(`Left ${f.b.root} behind: ${f.agent.relativeToRoot} (changed)`));
  assert.equal(await fs.readFile(f.agent.target, 'utf8'), 'Edited B\n');
  assert.deepEqual(await fs.readFile(f.a.brandInstallRecordPath), before);
});

test('install updates another eligible owner even when B is left behind and exits one', async (t) => {
  const f = await fixture(t);
  const c = resolveHost({ host: path.join(f.root, 'C'), brandRoot: f.a.brandRoot, codexHome: path.dirname(f.a.codexRulesDir) });
  assert.equal((await install({ host: c, env })).exitCode, 0);
  const record = await readInstallRecordFile(f.a);
  const cAgent = path.join(c.root, f.agent.relativeToRoot);
  await fs.writeFile(cAgent, 'Previously installed C agent\n');
  record.owners[key(c)].fingerprints.claude[f.agent.relativeToRoot] = await fileFingerprint(cAgent);
  await fs.writeFile(f.a.brandInstallRecordPath, JSON.stringify(record, null, 2) + '\n');
  await fs.writeFile(f.agent.target, 'Edited B\n');
  await requireInstall(f);
  const result = await install({ host: f.a, env });
  const after = await readInstallRecordFile(f.a);
  assert.equal(result.exitCode, 1);
  assert.ok(result.output.startsWith('Installed '));
  assert.ok(result.output.includes(`Left ${f.b.root} behind: ${f.agent.relativeToRoot} (changed)`));
  assert.ok(result.output.includes(`Updated 1 file(s) and 0 hook(s) of ${c.root}.`));
  assert.equal(await fs.readFile(f.agent.target, 'utf8'), 'Edited B\n');
  assert.deepEqual(after.owners[key(f.b)], record.owners[key(f.b)]);
  assert.deepEqual(await fs.readFile(cAgent), await plannedContent(f.agent, f.b.brandRoot));
  assert.equal(after.owners[key(c)].fingerprints.claude[f.agent.relativeToRoot], await fileFingerprint(cAgent));
});

for (const stamp of ['aged', 'missing']) {
  test(`install refreshes A's ${stamp} own image stamp without changing agent bytes`, async (t) => {
    const f = await fixture(t);
    const plan = await buildInstallPlan(f.a);
    const agents = plan.filter((item) => item.root === 'claude' && item.target.startsWith(f.a.agentsDir + path.sep));
    assert.ok(agents.length > 0);
    const before = await Promise.all(agents.map((item) => fs.readFile(item.target)));
    const owner = f.record.owners[key(f.a)];
    if (stamp === 'aged') owner.imageFingerprint = 'a'.repeat(64);
    else delete owner.imageFingerprint;
    await fs.writeFile(f.a.brandInstallRecordPath, JSON.stringify(f.record, null, 2) + '\n');
    const agedRecord = await readInstallRecordFile(f.a);
    assert.equal(agedRecord.owners[key(f.a)].imageFingerprint, stamp === 'aged' ? 'a'.repeat(64) : undefined);
    const result = await install({ host: f.a, env });
    const record = await readInstallRecordFile(f.a);
    assert.equal(result.exitCode, 0);
    assert.ok(result.output.startsWith('Installed '));
    assert.equal(record.owners[key(f.a)].imageFingerprint, imageFingerprint(record.image));
    assert.notEqual(record.owners[key(f.a)].imageFingerprint, null);
    assert.deepEqual(await Promise.all(agents.map((item) => fs.readFile(item.target))), before);
    const refreshed = await fs.readFile(f.a.brandInstallRecordPath);
    const second = await install({ host: f.a, env });
    assert.equal(second.exitCode, 0);
    assert.ok(second.output.startsWith('codex-bridge is already installed; nothing to do.'));
    assert.deepEqual(await fs.readFile(f.a.brandInstallRecordPath), refreshed);
  });
}
