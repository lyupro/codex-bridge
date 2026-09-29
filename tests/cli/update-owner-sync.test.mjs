/** Plan_65 D7: update keeps every recorded owner current without borrowing the initiator's force. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import { normalizeRepoPath } from '../../src/home/lib/runner/project-dir.mjs';
import { resolveHost } from '../../cli/hosts.mjs';
import { install } from '../../cli/install.mjs';
import { update } from '../../cli/update.mjs';
import { buildInstallPlan, fileFingerprint, PACKAGE_ROOT } from '../../cli/manifest.mjs';
import { readInstallRecordFile } from '../../cli/install-record.mjs';
import { plannedContent } from '../../cli/copy.mjs';

const env = { PATH: '', CODEX_BRIDGE_CWD: PACKAGE_ROOT };
const key = (host) => normalizeRepoPath(host.root);

async function fixture(t) {
  const root = makeTempTree('update-owner-sync-');
  t.after(() => removeTempTree(root));
  const options = { brandRoot: path.join(root, 'home'), codexHome: path.join(root, 'codex') };
  const a = resolveHost({ ...options, host: path.join(root, 'A') });
  const b = resolveHost({ ...options, host: path.join(root, 'B') });
  assert.equal((await install({ host: a, env })).exitCode, 0);
  const baseline = await update({ host: a, env });
  assert.equal((await install({ host: b, env })).exitCode, 0);
  const plan = await buildInstallPlan(b);
  const agent = plan.find((item) => item.root === 'claude' && item.target.startsWith(b.agentsDir + path.sep));
  assert.ok(agent);
  return { root, a, b, agent, baseline, record: await readInstallRecordFile(a) };
}

async function oldAgent(f, host) {
  const target = path.join(host.root, f.agent.relativeToRoot);
  await fs.writeFile(target, 'Previously installed agent\n');
  f.record.owners[key(host)].version = '0.1.0';
  f.record.owners[key(host)].fingerprints.claude[f.agent.relativeToRoot] = await fileFingerprint(target);
  await fs.writeFile(f.a.brandInstallRecordPath, JSON.stringify(f.record, null, 2) + '\n');
}

async function snapshot(f) {
  const paths = [path.join(f.a.root, f.agent.relativeToRoot), f.agent.target,
    f.a.brandInstallRecordPath, f.a.settingsPath, f.b.settingsPath,
    path.join(f.a.codexRulesDir, 'codex-bridge.rules'), f.a.brandConfigPath, f.a.brandConventionsPath];
  return Promise.all(paths.map(async (target) => [await fs.readFile(target), (await fs.stat(target)).mtimeMs]));
}

test('up-to-date A updates B recorded old bytes and advances its owner row', async (t) => {
  const f = await fixture(t);
  await oldAgent(f, f.b);
  const result = await update({ host: f.a, env });
  const record = await readInstallRecordFile(f.a);
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, `${f.baseline.output}\nUpdated 1 file(s) and 0 hook(s) of ${f.b.root}.`);
  assert.deepEqual(await fs.readFile(f.agent.target), await plannedContent(f.agent, f.b.brandRoot));
  assert.equal(record.owners[key(f.b)].fingerprints.claude[f.agent.relativeToRoot], await fileFingerprint(f.agent.target));
  assert.equal(record.owners[key(f.b)].version, record.image.version);
});

test('up-to-date A leaves edited B untouched and exits one', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.agent.target, 'Operator-edited B\n');
  const result = await update({ host: f.a, env });
  assert.equal(result.exitCode, 1);
  assert.ok(result.output.startsWith(f.baseline.output + '\n'));
  assert.ok(result.output.includes(`Left ${f.b.root} behind: ${f.agent.relativeToRoot} (changed)`));
  assert.equal(await fs.readFile(f.agent.target, 'utf8'), 'Operator-edited B\n');
  assert.deepEqual((await readInstallRecordFile(f.a)).owners[key(f.b)], f.record.owners[key(f.b)]);
});

test('updated A retires legacy layout and guard logs and prints its summary when B is edited', async (t) => {
  const f = await fixture(t);
  await oldAgent(f, f.a);
  await fs.writeFile(f.agent.target, 'Operator-edited B\n');
  await fs.mkdir(f.a.legacyAgentsDir, { recursive: true });
  const retired = path.join(f.a.legacyAgentsDir, path.basename(f.agent.target));
  await fs.writeFile(retired, 'Legacy package agent\n');
  const relative = `agents/codex/${path.basename(retired)}`;
  // D7: record the retired package file so cleanup removes it rather than preserving a foreign file.
  f.record.owners[key(f.a)].files.push({ root: 'claude', path: relative });
  f.record.owners[key(f.a)].fingerprints.claude[relative] = await fileFingerprint(retired);
  await fs.writeFile(f.a.brandInstallRecordPath, JSON.stringify(f.record, null, 2) + '\n');
  const log = path.join(path.dirname(f.a.settingsPath), 'logs', 'codex-reply-guard.blocked.json');
  await fs.mkdir(path.dirname(log), { recursive: true });
  await fs.writeFile(log, '{}\n');
  const result = await update({ host: f.a, env });
  assert.equal(result.exitCode, 1);
  assert.ok(result.output.startsWith('Updated codex-bridge: 1 updated, 1 removed.\nSource: '));
  assert.ok(result.output.includes(`Removed ${path.join('logs', 'codex-reply-guard.blocked.json')}.`));
  assert.equal(result.output.split(`Left ${f.b.root} behind:`).length - 1, 1);
  assert.deepEqual(await fs.readFile(path.join(f.a.root, f.agent.relativeToRoot)), await plannedContent(f.agent, f.a.brandRoot));
  await assert.rejects(fs.access(f.a.legacyAgentsDir), { code: 'ENOENT' });
  await assert.rejects(fs.access(log), { code: 'ENOENT' });
  assert.equal(await fs.readFile(f.agent.target, 'utf8'), 'Operator-edited B\n');
  assert.deepEqual((await readInstallRecordFile(f.a)).owners[key(f.b)], f.record.owners[key(f.b)]);
});

for (const current of [true, false]) {
  test(`dry run only plans lagging B when A is ${current ? 'up to date' : 'outdated'}`, async (t) => {
    const f = await fixture(t);
    await oldAgent(f, f.b);
    if (!current) await oldAgent(f, f.a);
    const before = await snapshot(f);
    const result = await update({ host: f.a, env, dryRun: true });
    assert.equal(result.exitCode, 0);
    assert.ok(result.output.startsWith(current ? f.baseline.output + '\n' : 'Would update codex-bridge with '));
    assert.ok(result.output.includes(`Would update 1 file(s) and 0 hook(s) of ${f.b.root}.`));
    assert.doesNotMatch(result.output, /Updated 1 file/);
    assert.deepEqual(await snapshot(f), before);
  });
}

test('current A and B preserve the existing up-to-date output byte-for-byte', async (t) => {
  const f = await fixture(t);
  const before = await snapshot(f);
  const result = await update({ host: f.a, env });
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, f.baseline.output);
  assert.ok(result.output.startsWith('codex-bridge is up to date with '));
  assert.equal(result.output.split('\n').length, 1);
  assert.deepEqual(await snapshot(f), before);
});

test('--force updates edited A without overwriting or advancing edited B', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.a.root, f.agent.relativeToRoot), 'Operator-edited A\n');
  await fs.writeFile(f.agent.target, 'Operator-edited B\n');
  const result = await update({ host: f.a, env, force: true });
  assert.equal(result.exitCode, 1);
  assert.ok(result.output.startsWith('Updated codex-bridge: 1 overwritten.\n'));
  assert.equal(result.output.split(`Left ${f.b.root} behind:`).length - 1, 1);
  assert.deepEqual(await fs.readFile(path.join(f.a.root, f.agent.relativeToRoot)), await plannedContent(f.agent, f.a.brandRoot));
  assert.equal(await fs.readFile(f.agent.target, 'utf8'), 'Operator-edited B\n');
  assert.deepEqual((await readInstallRecordFile(f.a)).owners[key(f.b)], f.record.owners[key(f.b)]);
});

test('a host failure still stops before syncing another owner', async (t) => {
  const f = await fixture(t);
  await oldAgent(f, f.b);
  await fs.unlink(path.join(f.a.root, f.agent.relativeToRoot));
  const before = await fs.readFile(f.a.brandInstallRecordPath);
  const result = await update({ host: f.a, env });
  assert.equal(result.exitCode, 1);
  assert.ok(result.output.startsWith('Update stopped for these paths:'));
  assert.doesNotMatch(result.output, /Updated .* of |Left .* behind:/);
  assert.equal(await fs.readFile(f.agent.target, 'utf8'), 'Previously installed agent\n');
  assert.deepEqual(await fs.readFile(f.a.brandInstallRecordPath), before);
});

test('recording an unrecorded A gets its single owner sync from install', async (t) => {
  const f = await fixture(t);
  await oldAgent(f, f.b);
  delete f.record.owners[key(f.a)];
  await fs.writeFile(f.a.brandInstallRecordPath, JSON.stringify(f.record, null, 2) + '\n');
  const result = await update({ host: f.a, env });
  assert.equal(result.exitCode, 0);
  assert.ok(result.output.startsWith(`No installation record names ${f.a.root}; recording what is installed.\n`));
  assert.equal(result.output.split(`Updated 1 file(s) and 0 hook(s) of ${f.b.root}.`).length - 1, 1);
  assert.deepEqual(await fs.readFile(f.agent.target), await plannedContent(f.agent, f.b.brandRoot));
});

for (const current of [true, false]) {
  test(`dry run exits zero for edited B when A is ${current ? 'up to date' : 'outdated'}`, async (t) => {
    const f = await fixture(t);
    if (!current) await oldAgent(f, f.a);
    await fs.writeFile(f.agent.target, 'Operator-edited B\n');
    const before = await snapshot(f);
    const result = await update({ host: f.a, env, dryRun: true });
    assert.equal(result.exitCode, 0);
    assert.ok(result.output.includes(`Left ${f.b.root} behind: ${f.agent.relativeToRoot} (changed)`));
    assert.deepEqual(await snapshot(f), before);
  });
}
