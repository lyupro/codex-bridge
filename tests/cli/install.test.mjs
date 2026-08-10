/** Verifies end-to-end copy installation, dry runs, conflicts, and idempotency. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveHost } from '../../cli/hosts.mjs';
import { install } from '../../cli/install.mjs';
import {
  buildInstallPlan,
  HOOK_DEFINITIONS,
  installRecordPath,
  legacyInstallRecordPath,
  readInstallRecord,
  recordTarget,
} from '../../cli/manifest.mjs';
import { RULES_REGISTRY_NAME } from '../../cli/rules-owners.mjs';
import { uninstall } from '../../cli/uninstall.mjs';
import { update } from '../../cli/update.mjs';
import { normalizeRepoPath } from '../../src/runner/project-dir.mjs';
import { allFiles, fixture } from './host-fixture.mjs';

async function backups(host) {
  try {
    return (await fs.readdir(host.root)).filter((name) => name.startsWith('settings.json.codex-bridge-backup-'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function fileHash(target) {
  return createHash('sha256').update(await fs.readFile(target)).digest('hex');
}

function rulesRegistryPath(host) {
  return path.join(host.codexRulesDir, RULES_REGISTRY_NAME);
}

async function readRulesRegistry(host) {
  return JSON.parse(await fs.readFile(rulesRegistryPath(host), 'utf8'));
}

test('a rendered file is fingerprinted as written, not as shipped', async (t) => {
  const { host } = await fixture(t);
  await install({ host });
  const record = await readInstallRecord(host);
  const file = record.files.find((entry) => entry.path.endsWith('codex-build.md'));
  const hash = async (target) => createHash('sha256').update(await fs.readFile(target)).digest('hex');
  assert.equal(record.fingerprints[file.root][file.path], await hash(recordTarget(host, file)));
  assert.notEqual(record.fingerprints[file.root][file.path], await hash('src/agents/codex-build.md'));
});

test('install copies the exact plan, expands placeholders, and writes a valid record', async (t) => {
  const { host } = await fixture(t);
  const plan = await buildInstallPlan(host);
  const result = await install({ host });
  assert.equal(result.exitCode, 0);
  const record = await readInstallRecord(host);
  assert.deepEqual(record.files, plan.map((item) => ({ root: item.root, path: item.relativeToRoot })));
  assert.equal(record.rules.path, path.join(host.codexRulesDir, 'codex-bridge.rules'));
  const rulesBytes = await fs.readFile(record.rules.path);
  assert.deepEqual(rulesBytes, await fs.readFile('src/rules/codex-bridge.rules'));
  assert.equal(record.rules.fingerprint, createHash('sha256').update(rulesBytes).digest('hex'));
  // From the definitions, not restated: a literal list here has to be edited every time the
  // package registers another hook, and until someone remembers, it contradicts the installer.
  assert.deepEqual(
    record.hooks.map(({ event }) => event),
    HOOK_DEFINITIONS.map(({ event }) => event),
  );
  const settings = JSON.parse(await fs.readFile(host.settingsPath, 'utf8'));
  // Read from the definitions rather than restated: the PreToolUse matcher lists every name a
  // host gives the subagent tool, and a literal here would have to be edited — or silently
  // contradict the installer — the first time that list grows.
  for (const definition of HOOK_DEFINITIONS) {
    assert.ok(settings.hooks[definition.event].some((group) => group.matcher === definition.matcher));
  }
  const installed = await allFiles(host.root);
  for (const file of record.files) {
    await fs.access(recordTarget(host, file));
  }
  await fs.access(installRecordPath(host));
  assert.ok(installed.includes('settings.json'));
  for (const item of plan.filter((entry) => entry.processing === 'placeholders')) {
    const content = await fs.readFile(item.target, 'utf8');
    const source = await fs.readFile(item.source, 'utf8');
    assert.equal(record.fingerprints[item.root][item.relativeToRoot], createHash('sha256').update(content).digest('hex'));
    assert.doesNotMatch(content, /\{\{CODEX_BRIDGE_DIR\}\}/);
    if (source.includes('{{CODEX_BRIDGE_DIR}}')) {
      assert.ok(content.includes(host.brandRunnerDir.replaceAll('\\', '/')));
      assert.notEqual(record.fingerprints[item.root][item.relativeToRoot], createHash('sha256').update(source).digest('hex'));
    }
  }
});

test('fresh install seeds conventions and update preserves an edited copy', async (t) => {
  const { host } = await fixture(t);
  await install({ host });
  const target = host.brandConventionsPath;
  assert.deepEqual(await fs.readFile(target), await fs.readFile('src/conventions.md'));
  const edited = '# host-specific rules\n\nKeep this wording.\n';
  await fs.writeFile(target, edited);
  assert.equal((await update({ host })).exitCode, 0);
  assert.equal(await fs.readFile(target, 'utf8'), edited);
});

test('a corrupt rules registry aborts install before writing any files', async (t) => {
  const { root, host } = await fixture(t);
  await fs.mkdir(host.codexRulesDir, { recursive: true });
  await fs.writeFile(rulesRegistryPath(host), '{"version":1,"owners":[');
  const before = await allFiles(root);
  await assert.rejects(() => install({ host }), /invalid rules ownership registry JSON/);
  assert.deepEqual(await allFiles(root), before);
});

test('a corrupt rules registry aborts update before removing or writing any files', async (t) => {
  const { root, host } = await fixture(t);
  await install({ host });
  await fs.writeFile(rulesRegistryPath(host), '{"version":1,"owners":[');
  const before = await allFiles(root);
  await assert.rejects(() => update({ host }), /invalid rules ownership registry JSON/);
  assert.deepEqual(await allFiles(root), before);
});

test('install and update keep one normalized owner without duplicates', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-owners-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const host = resolveHost({
    host: path.join(root, 'Host'),
    codexHome: path.join(root, 'codex-home'),
    brandRoot: path.join(root, 'brand'),
  });
  await install({ host });
  assert.deepEqual(await readRulesRegistry(host), {
    version: 1,
    owners: [normalizeRepoPath(host.root)],
  });
  await install({ host });
  await fs.rm(rulesRegistryPath(host));
  assert.equal((await update({ host })).exitCode, 0);
  assert.deepEqual(await readRulesRegistry(host), {
    version: 1,
    owners: [normalizeRepoPath(host.root)],
  });
});

test('install upgrades a legacy record with host fingerprints', async (t) => {
  const { host } = await fixture(t);
  await install({ host });
  const recordPath = installRecordPath(host);
  const legacyPath = legacyInstallRecordPath(host);
  const legacy = JSON.parse(await fs.readFile(recordPath, 'utf8'));
  delete legacy.fingerprints;
  await fs.rm(recordPath);
  await fs.mkdir(path.dirname(legacyPath), { recursive: true });
  await fs.writeFile(legacyPath, `${JSON.stringify(legacy, null, 2)}\n`);
  const result = await install({ host });
  assert.equal(result.exitCode, 0);
  assert.doesNotMatch(result.output, /nothing to do/);
  const upgraded = await readInstallRecord(host);
  assert.ok(upgraded.fingerprints);
  for (const file of upgraded.files) {
    const content = await fs.readFile(recordTarget(host, file));
    assert.equal(upgraded.fingerprints[file.root][file.path], createHash('sha256').update(content).digest('hex'));
  }
  await fs.access(installRecordPath(host));
});

test('second install is a complete no-op with unchanged mtimes and no new backup', async (t) => {
  const { host } = await fixture(t);
  await fs.mkdir(host.root, { recursive: true });
  await fs.writeFile(host.settingsPath, JSON.stringify({ model: 'test' }));
  await install({ host });
  const recordPath = installRecordPath(host);
  const before = {
    record: (await fs.stat(recordPath)).mtimeMs,
    settings: (await fs.stat(host.settingsPath)).mtimeMs,
    backups: await backups(host),
  };
  const result = await install({ host });
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /nothing to do/);
  assert.equal((await fs.stat(recordPath)).mtimeMs, before.record);
  assert.equal((await fs.stat(host.settingsPath)).mtimeMs, before.settings);
  assert.deepEqual(await backups(host), before.backups);
});

test('dry-run reports actions without creating the host, files, directories, or backups', async (t) => {
  const { host } = await fixture(t);
  const result = await install({ host, dryRun: true });
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /Would create/);
  await assert.rejects(() => fs.access(host.root), { code: 'ENOENT' });
  await assert.rejects(() => fs.access(host.brandRoot), { code: 'ENOENT' });
  await assert.rejects(() => fs.access(installRecordPath(host)), { code: 'ENOENT' });
});

test('unrecorded conflict fails untouched and --force overwrites it', async (t) => {
  const { host } = await fixture(t);
  const plan = await buildInstallPlan(host);
  const conflict = plan[0];
  await fs.mkdir(path.dirname(conflict.target), { recursive: true });
  await fs.writeFile(conflict.target, 'foreign');
  const refused = await install({ host });
  assert.equal(refused.exitCode, 1);
  assert.match(refused.output, new RegExp(conflict.relativeToRoot.replaceAll('/', '[\\\\/]')));
  assert.match(refused.output, /--force/);
  assert.equal(await fs.readFile(conflict.target, 'utf8'), 'foreign');
  assert.equal(await readInstallRecord(host), null);
  assert.equal((await install({ host, force: true })).exitCode, 0);
  assert.notEqual(await fs.readFile(conflict.target, 'utf8'), 'foreign');
});

test('a foreign rules file conflicts unless --force replaces it', async (t) => {
  const { host } = await fixture(t);
  const target = path.join(host.codexRulesDir, 'codex-bridge.rules');
  await fs.mkdir(host.codexRulesDir, { recursive: true });
  await fs.writeFile(target, 'foreign rules');
  const refused = await install({ host });
  assert.equal(refused.exitCode, 1);
  assert.match(refused.output, /codex-bridge\.rules/);
  assert.match(refused.output, /--force/);
  assert.equal(await fs.readFile(target, 'utf8'), 'foreign rules');
  assert.equal((await install({ host, force: true })).exitCode, 0);
  assert.deepEqual(await fs.readFile(target), await fs.readFile('src/rules/codex-bridge.rules'));
});

test('recorded manual changes conflict instead of being overwritten', async (t) => {
  const { host } = await fixture(t);
  const plan = await buildInstallPlan(host);
  await install({ host });
  const changed = plan[0];
  await fs.writeFile(changed.target, 'manual change');
  const refused = await install({ host });
  assert.equal(refused.exitCode, 1);
  assert.match(refused.output, /Conflicting files/);
  assert.equal(await fs.readFile(changed.target, 'utf8'), 'manual change');
});

test('install restores a missing recorded rules file instead of reporting a no-op', async (t) => {
  const { host } = await fixture(t);
  await install({ host });
  const record = await readInstallRecord(host);
  await fs.rm(record.rules.path);
  const restored = await install({ host });
  assert.equal(restored.exitCode, 0);
  assert.doesNotMatch(restored.output, /nothing to do/);
  assert.deepEqual(await fs.readFile(record.rules.path), await fs.readFile('src/rules/codex-bridge.rules'));
  assert.equal((await readInstallRecord(host)).rules.fingerprint, await fileHash(record.rules.path));
});

test('invalid settings aborts before copying any package file', async (t) => {
  const { host } = await fixture(t);
  await fs.mkdir(host.root, { recursive: true });
  await fs.writeFile(host.settingsPath, '{ broken');
  await assert.rejects(() => install({ host }), /cannot parse/);
  assert.equal(await fs.readFile(host.settingsPath, 'utf8'), '{ broken');
  assert.deepEqual(await allFiles(host.root), ['settings.json']);
});
