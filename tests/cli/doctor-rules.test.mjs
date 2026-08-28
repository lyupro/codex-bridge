/** Verifies how doctor judges the Codex rules file and its ownership registry. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { diagnose, renderDoctor } from '../../cli/doctor.mjs';
import { fileFingerprint, writeInstallRecord } from '../../cli/manifest.mjs';
import { RULES_REGISTRY_NAME } from '../../cli/rules-owners.mjs';
import { normalizeRepoPath } from '../../src/home/lib/runner/project-dir.mjs';
import { codexProbe, hostFixture, installedFixture, ownPackage } from './doctor-fixtures.mjs';

async function addRules(host, record, content = 'prefix_rule(pattern=["safe"], decision="allow")\n') {
  const rulePath = path.join(host.codexRulesDir, 'codex-bridge.rules');
  await fs.mkdir(path.dirname(rulePath), { recursive: true });
  await fs.writeFile(rulePath, content);
  record.rules = { path: rulePath, fingerprint: await fileFingerprint(rulePath) };
  await writeInstallRecord(host, record);
  return rulePath;
}

test('rules cannot be checked before installation', async (t) => {
  const host = await hostFixture(t);
  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  assert.deepEqual(result.checks.find((item) => item.key === 'rules'), {
    key: 'rules',
    status: 'warn',
    value: 'cannot check before installation',
  });
});

test('an old installation record warns that update will add rules', async (t) => {
  const { host } = await installedFixture(t);
  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  const rules = result.checks.find((item) => item.key === 'rules');
  assert.equal(rules.status, 'warn');
  assert.match(rules.value, /not installed by this installation/i);
  assert.match(rules.value, /install or update/i);
});

test('rules matching their recorded fingerprint are healthy', async (t) => {
  const { host, record } = await installedFixture(t);
  const rulePath = await addRules(host, record);
  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  assert.deepEqual(result.checks.find((item) => item.key === 'rules'), {
    key: 'rules',
    status: 'ok',
    value: `${rulePath} (matches record)`,
  });
  assert.equal(result.exitCode, 0);
});

test('doctor reports multiple owners of shared rules', async (t) => {
  const { host, record } = await installedFixture(t);
  await addRules(host, record);
  const otherHost = path.join(path.dirname(host.root), 'other-host');
  await fs.writeFile(
    path.join(host.codexRulesDir, RULES_REGISTRY_NAME),
    `${JSON.stringify({
      version: 1,
      owners: [normalizeRepoPath(host.root), normalizeRepoPath(otherHost)],
    }, null, 2)}\n`,
  );
  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  const rules = result.checks.find((item) => item.key === 'rules');
  assert.equal(rules.status, 'ok');
  assert.match(rules.value, /2 owners/);
  assert.match(renderDoctor(result), /rules: .*2 owners/);
});

test('corrupt rules registry fails only the rules check and keeps all diagnostics', async (t) => {
  const { host, record } = await installedFixture(t);
  await addRules(host, record);
  await fs.writeFile(
    path.join(host.codexRulesDir, RULES_REGISTRY_NAME),
    '{"version":1,"owners":[',
  );
  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  const rendered = renderDoctor(result);
  for (const key of ['source', 'host', 'installation', 'files', 'rules', 'hook:SubagentStop', 'hook:PreToolUse', 'codex', 'node', 'runsRoot', 'liveRuns', 'projectRuns']) {
    assert.match(rendered, new RegExp(`\\] ${key}:`));
  }
  const rules = result.checks.find((item) => item.key === 'rules');
  assert.equal(rules.status, 'fail');
  assert.match(rules.value, /invalid rules ownership registry JSON/);
  assert.equal(result.exitCode, 1);
});

test('missing recorded rules fail diagnosis and name their full path', async (t) => {
  const { host, record } = await installedFixture(t);
  const rulePath = await addRules(host, record);
  await fs.rm(rulePath);
  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  assert.deepEqual(result.checks.find((item) => item.key === 'rules'), {
    key: 'rules',
    status: 'fail',
    value: rulePath,
  });
  assert.equal(result.exitCode, 1);
});

test('manually modified rules warn without failing diagnosis', async (t) => {
  const { host, record } = await installedFixture(t);
  const rulePath = await addRules(host, record);
  await fs.writeFile(rulePath, 'manual operator rules\n');
  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage });
  const rules = result.checks.find((item) => item.key === 'rules');
  assert.equal(rules.status, 'warn');
  assert.match(rules.value, /modified after installation/i);
  assert.match(rules.value, new RegExp(rulePath.replaceAll('\\', '\\\\')));
  assert.equal(result.exitCode, 0);
});
