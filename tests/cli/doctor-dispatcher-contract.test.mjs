/** Verifies doctor turns the dispatcher contract record into one line per contract (Plan_62 D19). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { diagnose } from '../../cli/doctor.mjs';
import { DISPATCHER_CONTRACTS } from '../../cli/dispatcher-contract.mjs';
import { DISPATCHER_CONTRACT_FILE, writeDispatcherContract } from '../../cli/dispatcher-contract-record.mjs';
import { brandStateDir } from '../../src/home/lib/brand-home.mjs';
import { codexProbe, installedFixture, ownPackage } from './doctor-fixtures.mjs';

const verdicts = (result) => Object.fromEntries(DISPATCHER_CONTRACTS.map((name) => [name, { result, detail: name }]));
const contractLines = (result) => result.checks.filter((item) => item.key.startsWith('dispatcherContract'));

function record(results) {
  return { hosts: { '2.1.281': { contracts: Object.fromEntries(Object.entries(results).map(([name, result]) => [name, { result, checkedAt: '2026-09-24T12:00:00Z' }])) } } };
}

async function run(t, options) {
  const { host } = await installedFixture(t);
  return diagnose({ host, codexProbe, currentPackage: ownPackage, hostVersion: '2.1.281', ...options });
}

test('a never probed host warns once per contract and keeps the exit code', async (t) => {
  const result = await run(t, {});
  const lines = contractLines(result);
  assert.deepEqual(lines.map((item) => item.key), DISPATCHER_CONTRACTS.map((name) => `dispatcherContract:${name}`));
  assert.ok(lines.every((item) => item.status === 'warn' && /never been probed.*--probe-contract/.test(item.value)));
  assert.equal(result.exitCode, 0);
});

test('doctor reads the record the probe wrote into the fixture brand state', async (t) => {
  const { host } = await installedFixture(t);
  writeDispatcherContract({ stateDir: brandStateDir(host.brandRoot), version: '2.1.281', verdicts: verdicts('honored') });
  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage, hostVersion: '2.1.281' });
  assert.ok(contractLines(result).every((item) => item.status === 'ok' && /verified on host 2\.1\.281/.test(item.value)));
  assert.equal(result.exitCode, 0);
});

test('a changed contract fails its line and the doctor exit code', async (t) => {
  const result = await run(t, {
    dispatcherContractRecord: record({ agentIdentity: 'changed', shellStdout: 'honored', shellFailure: 'honored', agentTranscript: 'honored' }),
  });
  const lines = contractLines(result);
  assert.equal(lines[0].status, 'fail');
  assert.match(lines[0].value, /cannot be trusted.*agentIdentity changed/);
  assert.ok(lines.slice(1).every((item) => item.status === 'ok'));
  assert.equal(result.exitCode, 1);
});

test('a record from another host version and an unknown host version only warn', async (t) => {
  const honored = record(Object.fromEntries(DISPATCHER_CONTRACTS.map((name) => [name, 'honored'])));
  const stale = await run(t, { dispatcherContractRecord: honored, hostVersion: '2.1.282' });
  assert.ok(contractLines(stale).every((item) => item.status === 'warn' && /recorded for host 2\.1\.281/.test(item.value)));
  const unknown = await run(t, { dispatcherContractRecord: honored, hostVersion: null });
  assert.ok(contractLines(unknown).every((item) => item.status === 'warn' && /Host version is unknown/.test(item.value)));
  assert.equal(unknown.exitCode, 0);
});

test('a corrupt record is one warning that names the file to delete', async (t) => {
  const { host } = await installedFixture(t);
  const stateDir = brandStateDir(host.brandRoot);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, DISPATCHER_CONTRACT_FILE), '{broken', 'utf8');
  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage, hostVersion: '2.1.281' });
  const lines = contractLines(result);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].status, 'warn');
  assert.ok(lines[0].value.includes(path.join(stateDir, DISPATCHER_CONTRACT_FILE)));
  assert.equal(result.exitCode, 0);
});
