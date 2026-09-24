/** Verifies recorded installation updates across content classifications and safety modes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
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

import { fixture, installOutdated, PACKAGE, packageFixture, ROOT, SOURCE } from './update-fixtures.mjs';

test('update without an installation record refuses and recommends install', async (t) => {
  const { host } = await fixture(t);
  const result = await update({ host });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /not installed/i);
  assert.match(result.output, /install/i);
});

for (const version of [null, '0.5.4']) {
  test(`a fresh installation is up to date without rewriting any file${version ? ' (old installed package)' : ''}`, async (t) => {
    const { root, host } = await fixture(t);
    const packageRoot = version ? await packageFixture(root, path.join('node_modules', PACKAGE.name), { version }) : ROOT;
    const source = version ? `${PACKAGE.name}@${version} from ${packageRoot} (installed package)` : SOURCE;
    await install({ host, packageRoot });
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
    // The working directory is named explicitly: the suite itself runs inside a checkout, and the
    // mismatch warning below is exactly what that combination is supposed to produce.
    const env = { ...process.env, CODEX_BRIDGE_CWD: packageRoot };
    const result = await update({ host, packageRoot, force: Boolean(version), env });
    assert.deepEqual(result, { exitCode: 0, output: `codex-bridge is up to date with ${source}` });
    assert.deepEqual(
      await Promise.all(watched.map(async (target) => (await fs.stat(target)).mtimeMs)),
      before,
    );
  });
}

test('an outdated recorded file updates silently', async (t) => {
  const { host, changed } = await installOutdated(t);
  const result = await update({ host });
  assert.equal(result.exitCode, 0);
  assert.ok(result.output.endsWith(`Source: ${SOURCE}`));
  assert.doesNotMatch(result.output, new RegExp(`${changed.root}/${changed.relativeToRoot}`));
  assert.equal(await targetMatches(changed, host.brandRoot), true);
});

test('update migrates a legacy single-root layout and removes it once', async (t) => {
  const { host } = await fixture(t);
  const oldFiles = [
    ...new Set(HOOK_DEFINITIONS.map(({ file }) => `agents/codex/hooks/${file}`)),
    'commands/codex/env.md',
  ];
  const fingerprints = {};
  const hooks = [];
  const settingsHooks = {};
  for (const relative of oldFiles) {
    const target = path.join(host.root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `legacy ${path.basename(relative)}\n`);
    fingerprints[relative] = await fileFingerprint(target);
  }
  for (const [index, definition] of HOOK_DEFINITIONS.entries()) {
    const relative = `agents/codex/hooks/${definition.file}`;
    const target = path.join(host.root, relative);
    const command = index === 0 ? `codex-bridge hook ${definition.name}` : `node "${target}"`;
    hooks.push({ event: definition.event, path: relative, command, form: 'path' });
    settingsHooks[definition.event] ??= [];
    settingsHooks[definition.event].push({
      matcher: definition.matcher,
      hooks: [{ type: 'command', command }],
    });
  }
  const oldCommand = oldFiles.at(-1);
  const oldCommandTarget = path.join(host.root, oldCommand);
  await fs.mkdir(path.dirname(oldCommandTarget), { recursive: true });
  await fs.writeFile(oldCommandTarget, 'legacy command\n');
  fingerprints[oldCommand] = await fileFingerprint(oldCommandTarget);
  const foreign = { value: true, nested: ['keep'] };
  await fs.writeFile(host.settingsPath, JSON.stringify({ foreign, hooks: settingsHooks }));
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
  await assert.rejects(() => fs.access(host.legacyAgentsDir), { code: 'ENOENT' });
  await assert.rejects(() => fs.access(host.legacyCommandsDir), { code: 'ENOENT' });
  const migrated = await readInstallRecord(host);
  assert.ok(migrated.files.some((file) => file.root === 'brand'));
  const settings = JSON.parse(await fs.readFile(host.settingsPath, 'utf8'));
  assert.deepEqual(settings.foreign, foreign);
  assert.equal(JSON.stringify(settings).includes(path.join(host.root, oldFiles[1])), false);

  const repeat = await update({ host });
  assert.deepEqual(repeat, { exitCode: 0, output: `codex-bridge is up to date with ${SOURCE}` });
  await assert.rejects(() => fs.access(legacyPath), { code: 'ENOENT' });
});

test('update preserves foreign files in the previous layout', async (t) => {
  const { host } = await fixture(t);
  const definition = HOOK_DEFINITIONS[0];
  const relative = `agents/codex/hooks/${definition.file}`;
  const target = path.join(host.root, relative);
  const foreignAgent = path.join(host.legacyAgentsDir, 'operator-notes.md');
  const foreignCommand = path.join(host.legacyCommandsDir, 'operator-command.md');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.mkdir(path.dirname(foreignCommand), { recursive: true });
  await fs.writeFile(target, 'legacy hook\n');
  await fs.writeFile(foreignAgent, 'keep this agent file\n');
  await fs.writeFile(foreignCommand, 'keep this command file\n');
  const command = `node "${target}"`;
  const currentPackage = await packageInfo();
  const legacyPath = legacyInstallRecordPath(host);
  await fs.writeFile(host.settingsPath, JSON.stringify({
    foreign: { value: 'keep' },
    hooks: {
      [definition.event]: [{ matcher: definition.matcher, hooks: [{ type: 'command', command }] }],
    },
  }));
  await fs.writeFile(legacyPath, `${JSON.stringify({
    ...currentPackage,
    installedAt: '2026-08-01T10:00:00.000Z',
    mode: 'copy',
    files: [relative],
    fingerprints: { [relative]: await fileFingerprint(target) },
    hooks: [{ event: definition.event, path: relative, command, form: 'path' }],
  }, null, 2)}\n`);

  const result = await update({ host, force: true });

  assert.equal(result.exitCode, 0);
  await assert.rejects(() => fs.access(target), { code: 'ENOENT' });
  assert.equal(await fs.readFile(foreignAgent, 'utf8'), 'keep this agent file\n');
  assert.equal(await fs.readFile(foreignCommand, 'utf8'), 'keep this command file\n');
  await fs.access(host.legacyAgentsDir);
  await fs.access(host.legacyCommandsDir);
  assert.deepEqual(JSON.parse(await fs.readFile(host.settingsPath, 'utf8')).foreign, { value: 'keep' });
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
    rules: await fs.readFile(installed.rules.path),
    settings: await fs.readFile(host.settingsPath),
  };
  const result = await update({ host, dryRun: true });
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /Would update/);
  assert.ok(result.output.startsWith(`Would update codex-bridge with ${SOURCE}.\n`));
  for (const [file, content] of before.files) {
    assert.deepEqual(await fs.readFile(recordTarget(host, file)), content);
  }
  assert.deepEqual(await fs.readFile(recordPath), before.record);
  assert.deepEqual(await fs.readFile(installed.rules.path), before.rules);
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

test('update names the checkout the operator is standing in when it is not the copy that ran', async (t) => {
  // 2026-09-07: the operator stood in a 0.6.0 clone while PATH held the previous release. Update
  // compared the home against its own files, answered "up to date" and named no package at all.
  const { root, host } = await fixture(t);
  const packageRoot = await packageFixture(root, path.join('node_modules', PACKAGE.name), { version: '0.5.4' });
  const checkout = await packageFixture(root, 'checkout', { version: '9.9.9' });
  await install({ host, packageRoot });
  const env = { ...process.env, CODEX_BRIDGE_CWD: checkout };
  const result = await update({ host, packageRoot, force: true, env });
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /up to date with @lyupro\/codex-bridge@0\.5\.4 /);
  assert.match(result.output, /Run from 0\.5\.4; the checkout at .* is 9\.9\.9\./);
  assert.match(result.output, /npm i -g @lyupro\/codex-bridge@9\.9\.9/);
});
