/** Verifies Plan_67 D4/D8 dispatcher-model rows, ledger loading and doctor exit codes. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diagnose, renderDoctor } from '../../cli/doctor.mjs';
import { brandStateDir } from '../../src/home/lib/brand-home.mjs';
import { recordDispatcherModel } from '../../src/home/lib/dispatcher-model.mjs';
import { emptyLedger, reduceObservation } from '../../src/home/lib/observation-ledger.mjs';
import { codexProbe, installedFixture, ownPackage } from './doctor-fixtures.mjs';

const hostVersion = '2.1.281';
const at = '2026-10-07T10:00:00.000Z';
const observation = (verdict, version = hostVersion) => ({
  key: `${version}|codex-build`, verdict, at, detail: 'model comparison',
  data: { hostVersion: version, agentType: 'codex-build', pinFamily: 'haiku',
    parsed: verdict === 'violation' ? ['sonnet'] : verdict === 'match' ? ['haiku'] : [] },
});
const runDoctor = (host, dispatcherModelRecord) => diagnose({
  host, codexProbe, currentPackage: ownPackage, hostVersion, dispatcherModelRecord,
});
const modelRow = (result) => result.checks.find((item) => item.key.startsWith('dispatcherModel'));

test('an injected violation fails doctor and recovery restores exit code zero', async (t) => {
  const { host } = await installedFixture(t);
  const violation = reduceObservation(emptyLedger(), observation('violation'));
  const failed = await runDoctor(host, violation);
  assert.equal(modelRow(failed).status, 'fail');
  assert.equal(failed.exitCode, 1);
  assert.match(renderDoctor(failed), /\[fail\] dispatcherModel:codex-build:.*Claude quota was spent/);
  const witnessIndex = failed.checks.findIndex((item) => item.key === 'handbackWitness');
  assert.equal(failed.checks[witnessIndex + 1].key, 'dispatcherModel:codex-build');

  const recovered = reduceObservation(violation, observation('match'));
  const healthy = await runDoctor(host, recovered);
  assert.equal(modelRow(healthy).status, 'ok');
  assert.equal(healthy.exitCode, 0);
  assert.match(modelRow(healthy).value, /recovered from earlier violation/);
});

test('doctor reads the ledger from the fixture brand home when no record is injected', async (t) => {
  const { host } = await installedFixture(t);
  await recordDispatcherModel({ stateDir: brandStateDir(host.brandRoot),
    observation: observation('violation'), now: at });
  const result = await runDoctor(host);
  assert.equal(modelRow(result).status, 'fail');
  assert.equal(result.exitCode, 1);

  const injected = await runDoctor(host, emptyLedger());
  assert.equal(modelRow(injected).status, 'ok');
  assert.equal(injected.exitCode, 0);
});

test('an unresolved violation warns without changing the exit code', async (t) => {
  const { host } = await installedFixture(t);
  const ledger = reduceObservation(reduceObservation(emptyLedger(), observation('violation')),
    observation('undetermined'));
  const result = await runDoctor(host, ledger);
  assert.equal(modelRow(result).status, 'warn');
  assert.equal(result.exitCode, 0);
  assert.match(modelRow(result).value, /not yet disproved/);
});

test('a violation on another host remains historical and does not fail doctor', async (t) => {
  const { host } = await installedFixture(t);
  const ledger = reduceObservation(emptyLedger(), observation('violation', '2.1.280'));
  const result = await runDoctor(host, ledger);
  assert.equal(modelRow(result).status, 'ok');
  assert.equal(result.exitCode, 0);
  assert.match(modelRow(result).value, /^Not observed in the last 24 hours — recorded when a dispatcher stops\./);
  assert.match(modelRow(result).value, /2\.1\.280: 1 entries, 1 unresolved violations/);
});

test('a corrupt injected ledger warns without failing doctor', async (t) => {
  const { host } = await installedFixture(t);
  const result = await runDoctor(host, { corrupt: true });
  assert.equal(modelRow(result).status, 'warn');
  assert.equal(result.exitCode, 0);
  assert.match(modelRow(result).value, /dispatcher-model\.json/);
});

test('2026-10-07 D12: a model violation on the non-newest active host fails doctor', async (t) => {
  const { host } = await installedFixture(t);
  const dispatcherModelRecord = reduceObservation(emptyLedger(), {
    ...observation('violation', '2.1.292'), key: '2.1.292|codex-scout',
    data: { ...observation('violation', '2.1.292').data, agentType: 'codex-scout' },
  });
  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage,
    now: new Date('2026-10-07T12:00:00.000Z'), dispatcherModelRecord,
    observations: { hosts: {
      '2.1.291': { lastSeen: '2026-10-07T11:00:00.000Z' },
      '2.1.292': { lastSeen: at },
    } },
  });
  const row = result.checks.find((item) => item.key === 'dispatcherModel:codex-scout');
  assert.equal(row.status, 'fail');
  assert.match(row.value, /^host 2\.1\.292:/);
  assert.equal(result.exitCode, 1);
  assert.match(result.checks.find((item) => item.key === 'sessionHost').value, /2\.1\.291/);
  assert.ok(result.checks.some((item) => item.key === 'otherHost:2.1.292'));
});

test('D12: the same model violation becomes history after 25 hours without later host activity', async (t) => {
  const { host } = await installedFixture(t);
  const oldAt = '2026-10-06T11:00:00.000Z';
  const dispatcherModelRecord = reduceObservation(emptyLedger(), {
    ...observation('violation', '2.1.292'), key: '2.1.292|codex-scout', at: oldAt,
    data: { ...observation('violation', '2.1.292').data, agentType: 'codex-scout' },
  });
  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage,
    now: new Date('2026-10-07T12:00:00.000Z'), dispatcherModelRecord,
    observations: { hosts: {
      '2.1.291': { lastSeen: '2026-10-07T11:00:00.000Z' },
      '2.1.292': { lastSeen: oldAt },
    } },
  });
  assert.equal(modelRow(result).status, 'ok');
  assert.match(modelRow(result).value, /History.*2\.1\.292: 1 entries, 1 unresolved violations/);
  assert.equal(result.exitCode, 0);
});

test('injected active hosts override hostVersion, including an explicitly empty list', async (t) => {
  const { host } = await installedFixture(t);
  const dispatcherModelRecord = reduceObservation(emptyLedger(), observation('violation', '2.1.292'));
  const options = { host, codexProbe, currentPackage: ownPackage, hostVersion, dispatcherModelRecord };
  const failed = await diagnose({ ...options, activeHosts: ['2.1.292'] });
  assert.equal(modelRow(failed).status, 'fail');
  assert.equal(failed.exitCode, 1);
  const historical = await diagnose({ ...options, activeHosts: [] });
  assert.equal(modelRow(historical).status, 'ok');
  assert.match(modelRow(historical).value, /History.*2\.1\.292: 1 entries, 1 unresolved violations/);
  assert.equal(historical.exitCode, 0);
});
