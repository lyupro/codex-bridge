/** Verifies the read-only host inspection: marks found on the host, deletion only with content evidence (Plan_65 D10). */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { resolveHost } from '../../cli/hosts.mjs';
import { install } from '../../cli/install.mjs';
import {
  buildInstallPlan,
  fileFingerprint,
  legacyInstallRecordPath,
} from '../../cli/manifest.mjs';
import { readInstallRecordFile } from '../../cli/install-record.mjs';
import { plannedContent } from '../../cli/copy.mjs';
import { PERMISSION_RULES } from '../../cli/permissions.mjs';
import { inspectHost, hasPackageMarks } from '../../cli/host-inspection.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

function fixture(t, prefix = 'host-inspection-') {
  const root = makeTempTree(prefix);
  t.after(() => removeTempTree(root));
  const host = resolveHost({
    host: path.join(root, 'host'),
    brandRoot: path.join(root, 'brand'),
    homedir: path.join(root, 'home'),
    codexHome: path.join(root, 'codex'),
  });
  return { root, host };
}

async function installFixture(host) {
  const result = await install({ host });
  assert.equal(result.exitCode, 0);
}

test('installed agent and command files, hooks, and package marks are detected', async (t) => {
  const { host } = fixture(t);
  await installFixture(host);
  const inspection = await inspectHost(host);
  const plan = await buildInstallPlan(host);
  const hostItems = plan.filter((item) => item.root === 'claude');
  assert.equal(inspection.files.length, hostItems.length);
  assert.ok(inspection.files.every((file) => file.disposition === 'remove'));
  assert.ok(inspection.files.every((file) => file.reason === 'matches the package'));
  assert.ok(inspection.hooks.length > 0);
  assert.equal(hasPackageMarks(inspection), true);
});

test('edited agent files are kept unless this host owner fingerprint records the edit', async (t) => {
  const { host } = fixture(t);
  await installFixture(host);
  const plan = await buildInstallPlan(host);
  const item = plan.find((candidate) => candidate.target.startsWith(host.agentsDir + path.sep));
  fs.writeFileSync(item.target, 'operator edit');
  const changed = await inspectHost(host);
  const kept = changed.files.find((file) => file.target === item.target);
  assert.equal(kept.disposition, 'keep');
  assert.equal(kept.reason, 'changed');
  const record = await readInstallRecordFile(host);
  const owner = Object.values(record.owners).find((entry) => entry.root === host.root);
  owner.fingerprints.claude[item.relativeToHost] = await fileFingerprint(item.target);
  const recorded = await inspectHost(host, { owner });
  const removed = recorded.files.find((file) => file.target === item.target);
  assert.equal(removed.disposition, 'remove');
  assert.equal(removed.reason, "matches this host's record");
});

test('unknown package-directory files and seed files are kept with distinct reasons', async (t) => {
  const { host } = fixture(t);
  fs.mkdirSync(host.agentsDir, { recursive: true });
  fs.writeFileSync(path.join(host.agentsDir, 'extra.md'), 'operator file');
  fs.writeFileSync(path.join(host.agentsDir, 'config.json'), '{}');
  fs.writeFileSync(path.join(host.agentsDir, 'conventions.md'), 'operator rules');
  const inspection = await inspectHost(host);
  const extra = inspection.files.find((file) => file.target.endsWith('extra.md'));
  const seed = inspection.files.find((file) => file.target.endsWith('config.json'));
  const conventions = inspection.files.find((file) => file.target.endsWith('conventions.md'));
  assert.equal(extra.disposition, 'keep');
  assert.equal(extra.reason, 'unknown');
  assert.equal(seed.disposition, 'keep');
  assert.equal(seed.reason, 'seed');
  assert.equal(conventions.disposition, 'keep');
  assert.equal(conventions.reason, 'seed');
});

test('legacy directories list matching planned basenames and the old record only', async (t) => {
  const { host } = fixture(t);
  const plan = await buildInstallPlan(host);
  const item = plan.find((candidate) => candidate.target.startsWith(host.agentsDir + path.sep));
  fs.mkdirSync(host.legacyAgentsDir, { recursive: true });
  fs.writeFileSync(path.join(host.legacyAgentsDir, path.basename(item.target)), 'foreign legacy copy');
  fs.writeFileSync(path.join(host.legacyAgentsDir, 'other.md'), 'foreign file');
  fs.writeFileSync(legacyInstallRecordPath(host), '{}');
  const inspection = await inspectHost(host);
  const legacyTarget = path.join(host.legacyAgentsDir, path.basename(item.target));
  const legacy = inspection.files.find((file) => file.target === legacyTarget);
  const record = inspection.files.find((file) => file.target === legacyInstallRecordPath(host));
  assert.equal(legacy.disposition, 'keep');
  assert.equal(legacy.reason, 'changed');
  assert.equal(inspection.files.some((file) => file.target.endsWith('other.md')), false);
  assert.equal(record.disposition, 'remove');
  assert.equal(record.reason, 'old installation record');
});

test('a legacy copy with the package bytes may be removed', async (t) => {
  const { host } = fixture(t);
  const plan = await buildInstallPlan(host);
  const item = plan.find((candidate) => candidate.target.startsWith(host.agentsDir + path.sep));
  const legacyTarget = path.join(host.legacyAgentsDir, path.basename(item.target));
  fs.mkdirSync(host.legacyAgentsDir, { recursive: true });
  fs.writeFileSync(legacyTarget, await plannedContent(item, host.brandRoot));

  const inspection = await inspectHost(host);

  const legacy = inspection.files.find((file) => file.target === legacyTarget);
  assert.equal(legacy.disposition, 'remove');
  assert.equal(legacy.reason, 'matches the package');
});

test('directory links are kept and their contents are not listed', async (t) => {
  const { root, host } = fixture(t);
  const target = path.join(root, 'linked-content');
  const link = path.join(host.agentsDir, 'linked');
  fs.mkdirSync(path.join(target, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(target, 'nested', 'hidden.md'), 'outside target');
  fs.mkdirSync(host.agentsDir, { recursive: true });
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  const inspection = await inspectHost(host);
  const linkFile = inspection.files.find((file) => file.target === link);
  assert.equal(linkFile.disposition, 'keep');
  assert.equal(linkFile.reason, 'link');
  assert.equal(inspection.files.some((file) => file.target.includes('hidden.md')), false);
});

test('permission strings alone do not create package marks', async (t) => {
  const { host } = fixture(t);
  fs.mkdirSync(host.root, { recursive: true });
  fs.writeFileSync(host.settingsPath, JSON.stringify({ permissions: { allow: [PERMISSION_RULES.allow[0]] } }));
  const inspection = await inspectHost(host);
  assert.equal(inspection.files.length, 0);
  assert.equal(inspection.hooks.length, 0);
  assert.ok(inspection.permissions.present > 0);
  assert.equal(hasPackageMarks(inspection), false);
});

test('unparseable settings report an error and no hooks', async (t) => {
  const { host } = fixture(t);
  fs.mkdirSync(host.root, { recursive: true });
  fs.writeFileSync(host.settingsPath, '{');
  const inspection = await inspectHost(host);
  assert.ok(inspection.settingsError);
  assert.deepEqual(inspection.hooks, []);
  assert.equal(inspection.permissions.present, null);
});

test('an empty host has no files, hooks, or settings error', async (t) => {
  const { host } = fixture(t);
  const inspection = await inspectHost(host);
  assert.deepEqual(inspection.files, []);
  assert.deepEqual(inspection.hooks, []);
  assert.equal(inspection.permissions.present, 0);
  assert.equal(inspection.settingsError, null);
  assert.equal(hasPackageMarks(inspection), false);
});