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
  assert.match(modelRow(result).value, /^Not observed yet/);
  assert.match(modelRow(result).value, /2\.1\.280: 1 entries, 1 unresolved violations/);
});

test('a corrupt injected ledger warns without failing doctor', async (t) => {
  const { host } = await installedFixture(t);
  const result = await runDoctor(host, { corrupt: true });
  assert.equal(modelRow(result).status, 'warn');
  assert.equal(result.exitCode, 0);
  assert.match(modelRow(result).value, /dispatcher-model\.json/);
});
