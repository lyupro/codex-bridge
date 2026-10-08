/** Plan_64 B3: host rules must match the package core for unconditional session loading. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { diagnose } from '../../cli/doctor.mjs';
import { claudeRulesCheck } from '../../cli/doctor-installation.mjs';
import { buildInstallPlan, writeInstallRecord } from '../../cli/manifest.mjs';
import { codexProbe, hostFixture, installedFixture, ownPackage } from './doctor-fixtures.mjs';

const bridgeProbe = () => ({ available: true, value: 'codex-bridge 0.1.0' });

test('doctor confirms planned host rules match this package immediately after the Codex rules check', async (t) => {
  const { host, record } = await installedFixture(t);
  const rules = (await buildInstallPlan(host)).filter((item) => path.dirname(item.target) === host.rulesDir);
  assert.ok(rules.length > 0);
  for (const item of rules) {
    assert.ok(record.files.some((file) => file.root === item.root && file.path === item.relativeToRoot));
  }
  const result = await diagnose({ host, codexProbe, bridgeProbe, currentPackage: ownPackage });
  const index = result.checks.findIndex((item) => item.key === 'rules');
  assert.deepEqual(result.checks[index + 1], {
    key: 'claudeRules',
    status: 'ok',
    value: `${rules.length} host rules file(s) match this package`,
  });
  assert.equal(result.exitCode, 0);
});

test('doctor fails and names a missing core with the force-update repair command', async (t) => {
  const { host } = await installedFixture(t);
  await fs.rm(path.join(host.rulesDir, 'core.md'));
  const result = await diagnose({ host, codexProbe, bridgeProbe, currentPackage: ownPackage });
  const rules = result.checks.find((item) => item.key === 'claudeRules');
  assert.equal(rules.status, 'fail');
  assert.match(rules.value, /core\.md.*run codex-bridge update --force/);
  assert.equal(result.exitCode, 1);
});

test('doctor fails on edited core bytes even when every recorded file is present', async (t) => {
  const { host } = await installedFixture(t);
  await fs.appendFile(path.join(host.rulesDir, 'core.md'), '\nlocal drift\n');
  const result = await diagnose({ host, codexProbe, bridgeProbe, currentPackage: ownPackage });
  const rules = result.checks.find((item) => item.key === 'claudeRules');
  assert.equal(rules.status, 'fail');
  assert.match(rules.value, /core\.md.*run codex-bridge update --force/);
  assert.equal(result.checks.find((item) => item.key === 'files').status, 'ok');
  assert.equal(result.exitCode, 1);
});

test('doctor rejects conditional core frontmatter through byte comparison', async (t) => {
  const { host } = await installedFixture(t);
  const target = path.join(host.rulesDir, 'core.md');
  await fs.writeFile(target, `---\npaths: src/**\n---\n${await fs.readFile(target, 'utf8')}`);
  const result = await diagnose({ host, codexProbe, bridgeProbe, currentPackage: ownPackage });
  assert.equal(result.checks.find((item) => item.key === 'claudeRules').status, 'fail');
  assert.equal(result.exitCode, 1);
});

test('doctor checks the current host rules plan even when an older record omits the core', async (t) => {
  const { host, record } = await installedFixture(t);
  record.files = record.files.filter((file) => file.path !== 'rules/codex-bridge/core.md');
  await writeInstallRecord(host, record);
  await fs.rm(path.join(host.rulesDir, 'core.md'));
  const result = await diagnose({ host, codexProbe, bridgeProbe, currentPackage: ownPackage });
  assert.equal(result.checks.find((item) => item.key === 'files').status, 'ok');
  assert.equal(result.checks.find((item) => item.key === 'claudeRules').status, 'fail');
  assert.equal(result.exitCode, 1);
});

test('claudeRulesCheck fails instead of declaring an empty destination selection healthy', async (t) => {
  const { host, record } = await installedFixture(t);
  /** A trailing separator normalizes in planned targets but cannot equal their dirname (Plan_64 B1). */
  const unmatchedHost = { ...host, rulesDir: `${host.rulesDir}${path.sep}` };
  assert.deepEqual(await claudeRulesCheck(unmatchedHost, record), {
    key: 'claudeRules',
    status: 'fail',
    value: 'This package plans no host rules; the package tree is broken',
  });
});

test('doctor warns that host rules were not checked without an installation record', async (t) => {
  const host = await hostFixture(t);
  const result = await diagnose({ host, codexProbe, bridgeProbe, currentPackage: ownPackage });
  assert.deepEqual(result.checks.find((item) => item.key === 'claudeRules'), {
    key: 'claudeRules',
    status: 'warn',
    value: 'Host rules were not checked; run codex-bridge install',
  });
  assert.deepEqual(await claudeRulesCheck(host, null), result.checks.find((item) => item.key === 'claudeRules'));
});
