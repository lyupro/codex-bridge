/** Exercises the read-only D7 plan against two real installs sharing one image. */
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
import { ownerSyncLines, planOwnerSync } from '../../cli/owner-sync.mjs';

const env = { PATH: '' };

async function fixture(t) {
  const dir = makeTempTree('owner-sync-');
  t.after(() => removeTempTree(dir));
  const options = { brandRoot: path.join(dir, 'home'), codexHome: path.join(dir, 'codex') };
  const a = resolveHost({ ...options, host: path.join(dir, 'A') });
  const b = resolveHost({ ...options, host: path.join(dir, 'B') });
  assert.equal((await install({ host: a, env })).exitCode, 0);
  assert.equal((await install({ host: b, env })).exitCode, 0);
  const items = (await buildInstallPlan(b)).filter((item) => item.root === 'claude');
  const agent = items.find((item) => item.target.startsWith(b.agentsDir + path.sep));
  return { dir, a, b, items, agent, record: await readInstallRecordFile(a) };
}

async function saveRecord(f) {
  await fs.writeFile(f.a.brandInstallRecordPath, JSON.stringify(f.record));
  f.record = await readInstallRecordFile(f.a);
}

async function snapshot(root) {
  const result = {};
  async function visit(target, relative) {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) {
      result[relative] = { link: await fs.readlink(target) };
    } else if (stat.isDirectory()) {
      result[relative] = { directory: true, mtime: stat.mtimeMs };
      for (const name of (await fs.readdir(target)).sort()) {
        await visit(path.join(target, name), `${relative}/${name}`);
      }
    } else {
      result[relative] = { bytes: (await fs.readFile(target)).toString('hex'), mtime: stat.mtimeMs };
    }
  }
  await visit(root, '');
  return result;
}

async function plan(f, initiator = f.a, options = {}) {
  const before = await snapshot(f.dir);
  const recordBefore = structuredClone(f.record);
  const result = await planOwnerSync(f.record, initiator, { env, ...options });
  assert.deepEqual(await snapshot(f.dir), before);
  assert.deepEqual(f.record, recordBefore);
  return result;
}

function agentState(owner, agent) {
  return owner.files.find(({ item }) => item.relativeToRoot === agent.relativeToRoot);
}

async function removeHook(f) {
  const target = hookTargets(f.b, env)[0];
  const settings = JSON.parse(await fs.readFile(f.b.settingsPath, 'utf8'));
  for (const group of settings.hooks[target.spec.event]) {
    group.hooks = group.hooks.filter((hook) => hook.command !== target.spec.command);
  }
  await fs.writeFile(f.b.settingsPath, JSON.stringify(settings));
  return target;
}

test('fresh shared installs are in sync, preserve owner metadata, and exclude the initiator', async (t) => {
  const f = await fixture(t);
  const result = await plan(f);
  const [owner] = result.owners;
  assert.equal(result.owners.length, 1);
  assert.equal(owner.root, f.b.root);
  assert.equal(owner.scope, f.record.owners[normalizeRepoPath(f.b.root)].scope);
  assert.equal(owner.version, f.record.owners[normalizeRepoPath(f.b.root)].version);
  assert.equal(owner.status, 'in-sync');
  assert.equal(owner.files.length, f.items.length);
  assert.ok(owner.files.every(({ item, state }) => item.root === 'claude' && state === 'current'));
  assert.ok(owner.hooks.every(({ item, state }) => item.spec && state === 'current'));
  assert.equal(owner.hooks.length, hookTargets(f.b, env).length);
  assert.ok(result.owners.every(({ root }) => root !== f.a.root));
  assert.deepEqual(ownerSyncLines(result), []);
});

test('recorded old agent content is replaceable using B own persisted fingerprint', async (t) => {
  const f = await fixture(t);
  const old = 'Older installed agent content\n';
  await fs.writeFile(f.agent.target, old);
  const row = f.record.owners[normalizeRepoPath(f.b.root)];
  row.version = '0.1.0';
  row.fingerprints.claude[f.agent.relativeToRoot] = await fileFingerprint(f.agent.target);
  await saveRecord(f);
  const result = await plan(f);
  const [owner] = result.owners;
  assert.equal(owner.status, 'eligible');
  assert.equal(owner.version, '0.1.0');
  assert.equal(agentState(owner, f.agent).state, 'replace');
  assert.equal(await fs.readFile(f.agent.target, 'utf8'), old);
  assert.deepEqual(ownerSyncLines(result), [`Would update 1 file(s) and 0 hook(s) of ${f.b.root}.`]);
});

test('edited owner files conflict and initiator force cannot authorize replacement', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.agent.target, 'Operator edit\n');
  const result = await plan(f, { ...f.a, force: true }, { force: true });
  const [owner] = result.owners;
  assert.equal(owner.status, 'conflict');
  assert.equal(agentState(owner, f.agent).state, 'conflict');
  assert.equal(agentState(owner, f.agent).reason, 'changed');
  assert.deepEqual(ownerSyncLines(result), [`Left ${f.b.root} behind: ${f.agent.relativeToRoot} (changed); run codex-bridge update --host "${f.b.root}" after resolving it.`]);
});

test('recorded missing owner files conflict rather than being recreated', async (t) => {
  const f = await fixture(t);
  await fs.unlink(f.agent.target);
  const result = await plan(f);
  const [owner] = result.owners;
  assert.equal(owner.status, 'conflict');
  assert.equal(agentState(owner, f.agent).reason, 'missing');
  assert.deepEqual(ownerSyncLines(result), [`Left ${f.b.root} behind: ${f.agent.relativeToRoot} (missing); run codex-bridge update --host "${f.b.root}" after resolving it.`]);
  await assert.rejects(fs.lstat(f.agent.target), { code: 'ENOENT' });
});

test('unrecorded absent files are eligible for creation', async (t) => {
  const f = await fixture(t);
  await fs.unlink(f.agent.target);
  const row = f.record.owners[normalizeRepoPath(f.b.root)];
  row.files = row.files.filter((file) => file.path !== f.agent.relativeToRoot);
  delete row.fingerprints.claude[f.agent.relativeToRoot];
  await saveRecord(f);
  const result = await plan(f);
  assert.equal(result.owners[0].status, 'eligible');
  assert.equal(agentState(result.owners[0], f.agent).state, 'create');
  assert.deepEqual(ownerSyncLines(result), [`Would update 1 file(s) and 0 hook(s) of ${f.b.root}.`]);
});

test('a removed hook is planned for registration without modifying settings', async (t) => {
  const f = await fixture(t);
  const target = await removeHook(f);
  const result = await plan(f);
  const [owner] = result.owners;
  const hook = owner.hooks.find(({ item }) => item.definition.name === target.definition.name);
  assert.equal(owner.status, 'eligible');
  assert.equal(hook.state, 'register');
  assert.deepEqual(hook.item.spec, target.spec);
  assert.deepEqual(ownerSyncLines(result), [`Would update 0 file(s) and 1 hook(s) of ${f.b.root}.`]);
});

test('file conflict takes priority over eligible file and hook changes', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.agent.target, 'Edited\n');
  await fs.unlink(f.items.find((item) => item !== f.agent).target);
  await removeHook(f);
  const result = await plan(f);
  assert.equal(result.owners[0].status, 'conflict');
  assert.equal(result.owners[0].files.filter(({ state }) => state === 'conflict').length, 2);
  assert.equal(result.owners[0].hooks.filter(({ state }) => state === 'register').length, 1);
  assert.match(ownerSyncLines(result)[0], /\(changed\), .*\(missing\)|\(missing\), .*\(changed\)/);
});

test('renamed-away owners are absent and never recreated', async (t) => {
  const f = await fixture(t);
  await fs.rename(f.b.root, `${f.b.root}-away`);
  const result = await plan(f);
  assert.equal(result.owners[0].status, 'unreachable');
  assert.equal(result.owners[0].reason, 'absent');
  assert.deepEqual(result.owners[0].files, []);
  assert.deepEqual(result.owners[0].hooks, []);
  assert.deepEqual(ownerSyncLines(result), [`Left ${f.b.root} behind: absent; run codex-bridge update --host "${f.b.root}" when it is available.`]);
  await assert.rejects(fs.lstat(f.b.root), { code: 'ENOENT' });
});

test('a non-directory owner root is unreachable with ENOTDIR', async (t) => {
  const f = await fixture(t);
  await fs.rename(f.b.root, `${f.b.root}-away`);
  await fs.writeFile(f.b.root, 'A file cannot be a host\n');
  const result = await plan(f);
  assert.equal(result.owners[0].status, 'unreachable');
  assert.equal(result.owners[0].reason, 'ENOTDIR');
});

test('an unreadable owner root retains its filesystem error code', async (t) => {
  const f = await fixture(t);
  const readdir = fs.readdir;
  t.mock.method(fs, 'readdir', async (target, ...args) => {
    if (target === f.b.root) throw Object.assign(new Error('Denied'), { code: 'EACCES' });
    return readdir(target, ...args);
  });
  const result = await planOwnerSync(f.record, f.a, { env });
  assert.equal(result.owners[0].status, 'unreachable');
  assert.equal(result.owners[0].reason, 'EACCES');
});

test('unparseable settings make the whole owner unreachable even with a file conflict', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.agent.target, 'Edited\n');
  await fs.writeFile(f.b.settingsPath, '{');
  const result = await plan(f);
  assert.equal(result.owners[0].status, 'unreachable');
  assert.match(result.owners[0].reason, /^settings unreadable: .+/);
  assert.equal(await fs.readFile(f.b.settingsPath, 'utf8'), '{');
  assert.deepEqual(ownerSyncLines(result), [`Left ${f.b.root} behind: ${result.owners[0].reason}; run codex-bridge update --host "${f.b.root}" when it is available.`]);
});

test('missing settings plan every hook for registration without creating settings', async (t) => {
  const f = await fixture(t);
  await fs.unlink(f.b.settingsPath);
  const result = await plan(f);
  assert.equal(result.owners[0].status, 'eligible');
  assert.ok(result.owners[0].hooks.every(({ state }) => state === 'register'));
  await assert.rejects(fs.lstat(f.b.settingsPath), { code: 'ENOENT' });
});

test('a target symlink or Windows junction conflicts without touching its destination', async (t) => {
  const f = await fixture(t);
  const destination = path.join(f.dir, 'foreign');
  await fs.mkdir(destination);
  const sentinel = path.join(destination, 'untouched.md');
  await fs.writeFile(sentinel, await fs.readFile(f.agent.target));
  await fs.unlink(f.agent.target);
  await fs.symlink(process.platform === 'win32' ? destination : sentinel, f.agent.target,
    process.platform === 'win32' ? 'junction' : 'file');
  const result = await plan(f);
  assert.equal(result.owners[0].status, 'conflict');
  assert.equal(agentState(result.owners[0], f.agent).reason, 'link');
  assert.deepEqual(await fs.readdir(destination), ['untouched.md']);
  assert.deepEqual(ownerSyncLines(result), [`Left ${f.b.root} behind: ${f.agent.relativeToRoot} (link); run codex-bridge update --host "${f.b.root}" after resolving it.`]);
});

test('dangling target links are conflicts rather than missing files', async (t) => {
  const f = await fixture(t);
  const destination = path.join(f.dir, 'link-destination');
  await fs.mkdir(destination);
  await fs.unlink(f.agent.target);
  await fs.symlink(destination, f.agent.target, process.platform === 'win32' ? 'junction' : 'dir');
  await fs.rename(destination, `${destination}-away`);
  const result = await plan(f);
  assert.equal(result.owners[0].status, 'conflict');
  assert.equal(agentState(result.owners[0], f.agent).reason, 'link');
});

test('matching bytes are current even when the recorded fingerprint is older', async (t) => {
  const f = await fixture(t);
  f.record.owners[normalizeRepoPath(f.b.root)].fingerprints.claude[f.agent.relativeToRoot] = 'a'.repeat(64);
  await saveRecord(f);
  const result = await plan(f, f.a, { packageRoot: PACKAGE_ROOT });
  assert.equal(result.owners[0].status, 'in-sync');
  assert.equal(agentState(result.owners[0], f.agent).state, 'current');
});

test('owners without fingerprints cannot overwrite differing files', async (t) => {
  const f = await fixture(t);
  delete f.record.image.fingerprints;
  for (const owner of Object.values(f.record.owners)) delete owner.fingerprints;
  await saveRecord(f);
  await fs.writeFile(f.agent.target, 'Unverifiable edit\n');
  const result = await plan(f);
  assert.equal(result.owners[0].status, 'conflict');
  assert.equal(agentState(result.owners[0], f.agent).reason, 'changed');
});

test('planning preserves permissions, operator seeds, unrelated settings, and Codex rules', async (t) => {
  const f = await fixture(t);
  const settings = JSON.parse(await fs.readFile(f.b.settingsPath, 'utf8'));
  settings.permissions = { allow: ['operator-only'], deny: ['private'], ask: ['custom'] };
  settings.operator = { keep: true };
  await fs.writeFile(f.b.settingsPath, JSON.stringify(settings));
  await fs.writeFile(f.a.brandConfigPath, 'Operator-owned seed\n');
  await fs.writeFile(f.a.brandConventionsPath, 'Operator-owned conventions\n');
  await fs.writeFile(path.join(f.a.codexRulesDir, 'codex-bridge.rules'), 'Operator rules\n');
  const result = await plan(f);
  assert.equal(result.owners[0].status, 'in-sync');
});

test('other owner rows are sorted by root and normalized initiator variants are excluded', async (t) => {
  const f = await fixture(t);
  const original = f.record.owners[normalizeRepoPath(f.b.root)];
  const zRoot = path.join(f.dir, 'Z');
  f.record.owners = {
    [normalizeRepoPath(zRoot)]: { ...structuredClone(original), root: zRoot, scope: 'project' },
    ...f.record.owners,
  };
  const initiator = { ...f.a, root: path.join(f.a.root, '.') };
  if (process.platform === 'win32') initiator.root = initiator.root.toUpperCase();
  const result = await plan(f, initiator);
  assert.deepEqual(result.owners.map(({ root }) => root), [f.b.root, zRoot]);
  assert.equal(result.owners[0].status, 'in-sync');
  assert.equal(result.owners[1].status, 'unreachable');
  assert.equal(result.owners[1].scope, 'project');
  assert.equal(result.owners[1].version, original.version);
});

test('a lone initiator produces an empty plan and no output', async (t) => {
  const f = await fixture(t);
  delete f.record.owners[normalizeRepoPath(f.b.root)];
  const result = await plan(f);
  assert.deepEqual(result, { owners: [] });
  assert.deepEqual(ownerSyncLines(result), []);
});
