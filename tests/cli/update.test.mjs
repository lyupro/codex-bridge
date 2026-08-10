/** Verifies recorded installation updates across content classifications and safety modes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveHost } from '../../cli/hosts.mjs';
import { install } from '../../cli/install.mjs';
import {
  buildInstallPlan,
  fileFingerprint,
  HOOK_DEFINITIONS,
  installRecordPath,
  legacyInstallRecordPath,
  packageInfo,
  readInstallRecord,
  recordTarget,
  rulesPlan,
} from '../../cli/manifest.mjs';
import { targetMatches } from '../../cli/copy.mjs';
import { update } from '../../cli/update.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-update-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  // Naming the Codex home is not optional: without it the installed rules land in the real one.
  return {
    root,
    host: resolveHost({
      host: path.join(root, 'host'),
      codexHome: path.join(root, 'codex-home'),
      brandRoot: path.join(root, 'brand'),
    }),
  };
}

async function packageFixture(root, name, { version = '0.0.0', extraFile } = {}) {
  const packageRoot = path.join(root, name);
  await fs.cp(path.join(ROOT, 'src'), path.join(packageRoot, 'src'), { recursive: true });
  const manifest = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  manifest.version = version;
  await fs.writeFile(path.join(packageRoot, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  if (extraFile) await fs.writeFile(path.join(packageRoot, 'src', extraFile), 'obsolete package file\n');
  return packageRoot;
}

async function installOutdated(t) {
  const value = await fixture(t);
  const oldPackage = await packageFixture(value.root, 'old-package');
  const oldPlan = await buildInstallPlan(value.host, oldPackage);
  await fs.writeFile(oldPlan[0].source, 'old package content\n');
  await install({ host: value.host, packageRoot: oldPackage });
  const currentPlan = await buildInstallPlan(value.host);
  const changed = currentPlan.find((item) =>
    item.root === oldPlan[0].root && item.relativeToRoot === oldPlan[0].relativeToRoot);
  return { ...value, changed };
}

test('update without an installation record refuses and recommends install', async (t) => {
  const { host } = await fixture(t);
  const result = await update({ host });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /not installed/i);
  assert.match(result.output, /install/i);
});

test('a fresh installation is up to date without rewriting any file', async (t) => {
  const { host } = await fixture(t);
  await install({ host });
  const record = await readInstallRecord(host);
  const watched = [
    ...record.files.map((file) => recordTarget(host, file)),
    record.rules.path,
    installRecordPath(host),
    host.settingsPath,
  ];
  const fixed = new Date('2020-01-02T03:04:05.000Z');
  await Promise.all(watched.map((target) => fs.utimes(target, fixed, fixed)));
  const before = await Promise.all(watched.map(async (target) => (await fs.stat(target)).mtimeMs));
  const result = await update({ host });
  assert.deepEqual(result, { exitCode: 0, output: 'codex-bridge is up to date' });
  assert.deepEqual(
    await Promise.all(watched.map(async (target) => (await fs.stat(target)).mtimeMs)),
    before,
  );
});

test('an outdated recorded file updates silently', async (t) => {
  const { host, changed } = await installOutdated(t);
  const result = await update({ host });
  assert.equal(result.exitCode, 0);
  assert.doesNotMatch(result.output, new RegExp(`${changed.root}/${changed.relativeToRoot}`));
  assert.equal(await targetMatches(changed, host.brandRoot), true);
});

test('outdated recorded rules are updated from the current package', async (t) => {
  const { root, host } = await fixture(t);
  const oldPackage = await packageFixture(root, 'old-rules-package');
  const oldRule = rulesPlan(host, oldPackage);
  await fs.writeFile(oldRule.source, 'old package rules\n');
  await install({ host, packageRoot: oldPackage });
  const result = await update({ host });
  assert.equal(result.exitCode, 0);
  assert.equal(await targetMatches({ ...rulesPlan(host), processing: 'copy' }, host.brandRoot), true);
});

test('missing rules stop update then --force restores them by full path', async (t) => {
  const { host } = await fixture(t);
  await install({ host });
  const rule = rulesPlan(host);
  await fs.rm(rule.target);
  const refused = await update({ host });
  assert.equal(refused.exitCode, 1);
  assert.match(refused.output, new RegExp(rule.target.replaceAll('\\', '\\\\')));
  const forced = await update({ host, force: true });
  assert.equal(forced.exitCode, 0);
  assert.equal(await targetMatches({ ...rule, processing: 'copy' }, host.brandRoot), true);
});

test('manually modified rules stop update and --force overwrites them', async (t) => {
  const { host } = await fixture(t);
  await install({ host });
  const rule = rulesPlan(host);
  await fs.writeFile(rule.target, 'manual operator rules\n');
  const refused = await update({ host });
  assert.equal(refused.exitCode, 1);
  assert.match(refused.output, new RegExp(rule.target.replaceAll('\\', '\\\\')));
  assert.match(refused.output, /--force/);
  assert.equal(await fs.readFile(rule.target, 'utf8'), 'manual operator rules\n');
  const forced = await update({ host, force: true });
  assert.equal(forced.exitCode, 0);
  assert.equal(await targetMatches({ ...rule, processing: 'copy' }, host.brandRoot), true);
});

test('a legacy record without rules adds and records the current rules', async (t) => {
  const { host } = await fixture(t);
  await install({ host });
  const rule = rulesPlan(host);
  const recordPath = installRecordPath(host);
  const legacy = JSON.parse(await fs.readFile(recordPath, 'utf8'));
  delete legacy.rules;
  await fs.writeFile(recordPath, `${JSON.stringify(legacy, null, 2)}\n`);
  await fs.writeFile(rule.target, 'unrecorded legacy rules\n');
  const result = await update({ host });
  assert.equal(result.exitCode, 0);
  assert.equal(await targetMatches({ ...rule, processing: 'copy' }, host.brandRoot), true);
  const current = await readInstallRecord(host);
  assert.equal(current.rules.path, rule.target);
  assert.equal(current.rules.fingerprint, await fileFingerprint(rule.target));
});

test('update migrates a legacy single-root layout and removes it once', async (t) => {
  const { host } = await fixture(t);
  const oldFiles = HOOK_DEFINITIONS.map(({ file }) => `agents/codex/hooks/${file}`);
  const fingerprints = {};
  const hooks = [];
  const settingsHooks = {};
  for (const [index, definition] of HOOK_DEFINITIONS.entries()) {
    const relative = oldFiles[index];
    const target = path.join(host.root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `legacy ${definition.file}\n`);
    fingerprints[relative] = await fileFingerprint(target);
    const command = index === 0 ? `codex-bridge hook ${definition.name}` : `node "${target}"`;
    hooks.push({ event: definition.event, path: relative, command, form: 'path' });
    settingsHooks[definition.event] ??= [];
    settingsHooks[definition.event].push({
      matcher: definition.matcher,
      hooks: [{ type: 'command', command }],
    });
  }
  await fs.writeFile(host.settingsPath, JSON.stringify({ foreign: true, hooks: settingsHooks }));
  const currentPackage = await packageInfo();
  const legacyPath = legacyInstallRecordPath(host);
  await fs.mkdir(path.dirname(legacyPath), { recursive: true });
  await fs.writeFile(legacyPath, `${JSON.stringify({
    ...currentPackage,
    installedAt: '2026-08-01T10:00:00.000Z',
    mode: 'copy',
    files: oldFiles,
    fingerprints,
    hooks,
  }, null, 2)}\n`);

  const result = await update({ host, force: true });
  assert.equal(result.exitCode, 0);
  await assert.rejects(() => fs.access(legacyPath), { code: 'ENOENT' });
  for (const relative of oldFiles) {
    await assert.rejects(() => fs.access(path.join(host.root, relative)), { code: 'ENOENT' });
  }
  const migrated = await readInstallRecord(host);
  assert.ok(migrated.files.some((file) => file.root === 'brand'));
  const settings = JSON.parse(await fs.readFile(host.settingsPath, 'utf8'));
  assert.equal(settings.foreign, true);
  assert.equal(JSON.stringify(settings).includes(path.join(host.root, oldFiles[1])), false);

  const repeat = await update({ host });
  assert.deepEqual(repeat, { exitCode: 0, output: 'codex-bridge is up to date' });
  await assert.rejects(() => fs.access(legacyPath), { code: 'ENOENT' });
});

test('a manually modified file stops update without changing the file or record', async (t) => {
  const { host } = await fixture(t);
  await install({ host });
  const changed = (await buildInstallPlan(host))[0];
  const recordPath = installRecordPath(host);
  const recordBefore = await fs.readFile(recordPath, 'utf8');
  await fs.writeFile(changed.target, 'manual change\n');
  const result = await update({ host });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, new RegExp(`${changed.root}/${changed.relativeToRoot}`));
  assert.match(result.output, /--force/);
  assert.equal(await fs.readFile(changed.target, 'utf8'), 'manual change\n');
  assert.equal(await fs.readFile(recordPath, 'utf8'), recordBefore);
});

test('--force overwrites a manually modified file', async (t) => {
  const { host } = await fixture(t);
  await install({ host });
  const changed = (await buildInstallPlan(host))[0];
  await fs.writeFile(changed.target, 'manual change\n');
  const result = await update({ host, force: true });
  assert.equal(result.exitCode, 0);
  assert.equal(await targetMatches(changed, host.brandRoot), true);
});

test('a missing file stops update then --force restores it', async (t) => {
  const { host } = await fixture(t);
  await install({ host });
  const missing = (await buildInstallPlan(host))[0];
  const recordPath = installRecordPath(host);
  const recordBefore = await fs.readFile(recordPath, 'utf8');
  await fs.rm(missing.target);
  const refused = await update({ host });
  assert.equal(refused.exitCode, 1);
  assert.match(refused.output, new RegExp(`${missing.root}/${missing.relativeToRoot}`));
  assert.equal(await fs.readFile(recordPath, 'utf8'), recordBefore);
  const forced = await update({ host, force: true });
  assert.equal(forced.exitCode, 0);
  assert.equal(await targetMatches(missing, host.brandRoot), true);
});

test('a matching orphan is removed from the host and rewritten record', async (t) => {
  const { root, host } = await fixture(t);
  const oldPackage = await packageFixture(root, 'old-package', { extraFile: 'obsolete.txt' });
  await install({ host, packageRoot: oldPackage });
  const orphan = (await readInstallRecord(host)).files.find((file) => file.path.endsWith('obsolete.txt'));
  const result = await update({ host });
  assert.equal(result.exitCode, 0);
  await assert.rejects(() => fs.access(recordTarget(host, orphan)), { code: 'ENOENT' });
  assert.equal((await readInstallRecord(host)).files.some((file) =>
    file.root === orphan.root && file.path === orphan.path), false);
});

test('a modified orphan is reported and preserved without --force', async (t) => {
  const { root, host } = await fixture(t);
  const oldPackage = await packageFixture(root, 'old-package', { extraFile: 'obsolete.txt' });
  await install({ host, packageRoot: oldPackage });
  const orphan = (await readInstallRecord(host)).files.find((file) => file.path.endsWith('obsolete.txt'));
  const target = recordTarget(host, orphan);
  await fs.writeFile(target, 'manual orphan\n');
  const result = await update({ host });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /obsolete\.txt/);
  assert.match(result.output, /modified/);
  assert.equal(await fs.readFile(target, 'utf8'), 'manual orphan\n');
});

test('a record without fingerprints treats differing files as modified and explains why', async (t) => {
  const { host } = await fixture(t);
  await install({ host });
  const changed = (await buildInstallPlan(host))[0];
  const recordPath = installRecordPath(host);
  const legacy = JSON.parse(await fs.readFile(recordPath, 'utf8'));
  delete legacy.fingerprints;
  await fs.writeFile(recordPath, `${JSON.stringify(legacy, null, 2)}\n`);
  await fs.writeFile(changed.target, 'legacy difference\n');
  const result = await update({ host });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /no fingerprints/i);
  assert.match(result.output, /treated as modified/i);
});

test('--dry-run reports future actions without changing files, record, or settings', async (t) => {
  const { host } = await installOutdated(t);
  const installed = await readInstallRecord(host);
  const recordPath = installRecordPath(host);
  const before = {
    files: await Promise.all(installed.files.map(async (file) => [
      file,
      await fs.readFile(recordTarget(host, file)),
    ])),
    record: await fs.readFile(recordPath),
    settings: await fs.readFile(host.settingsPath),
  };
  const result = await update({ host, dryRun: true });
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /Would update/);
  for (const [file, content] of before.files) {
    assert.deepEqual(await fs.readFile(recordTarget(host, file)), content);
  }
  assert.deepEqual(await fs.readFile(recordPath), before.record);
  assert.deepEqual(await fs.readFile(host.settingsPath), before.settings);
});

test('codex-runs artifacts survive update', async (t) => {
  const { host } = await fixture(t);
  await install({ host });
  const artifact = path.join(host.root, 'codex-runs', 'run.json');
  await fs.mkdir(path.dirname(artifact), { recursive: true });
  await fs.writeFile(artifact, 'keep\n');
  const result = await update({ host, force: true });
  assert.equal(result.exitCode, 0);
  assert.equal(await fs.readFile(artifact, 'utf8'), 'keep\n');
});

// A record naming a run folder is refused where it is read, so neither update nor uninstall has to
// carry its own guard against deleting the user's artifacts.
test('a record that claims a run artifact is refused, not obeyed', async (t) => {
  const { host } = await fixture(t);
  await install({ host });
  const artifact = path.join(host.root, 'codex-runs', 'run.json');
  await fs.mkdir(path.dirname(artifact), { recursive: true });
  await fs.writeFile(artifact, 'keep\n');
  const recordPath = installRecordPath(host);
  const record = JSON.parse(await fs.readFile(recordPath, 'utf8'));
  record.files.push({ root: 'claude', path: 'codex-runs/run.json' });
  record.fingerprints.claude['codex-runs/run.json'] = await fileFingerprint(artifact);
  await fs.writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  await assert.rejects(update({ host, force: true }), /must not name run artifacts/);
  assert.equal(await fs.readFile(artifact, 'utf8'), 'keep\n');
});
