/** Verifies the handback witness is exposed by doctor using the fixture host's brand home. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { diagnose } from '../../cli/doctor.mjs';
import {
  readHandbackWitness, recordInterceptedAttempt, recordWitnessObservation, witnessKey, WITNESS_FILE,
} from '../../src/home/lib/handback-witness.mjs';
import { entryState } from '../../src/home/lib/observation-ledger.mjs';
import { brandStateDir } from '../../src/home/lib/brand-home.mjs';
import { codexProbe, installedFixture, ownPackage } from './doctor-fixtures.mjs';

const hostVersion = '2.1.281';
const at = '2026-09-24T10:00:00.000Z';
const options = { cause: 'tools-outside-gate', hostVersion, agentType: 'codex-build' };
const runDoctor = (host) => diagnose({ host, codexProbe, currentPackage: ownPackage, hostVersion });
const witnessCheck = (result) => result.checks.find((item) => item.key === 'handbackWitness');
const alarm = (stateDir, fields = {}) => recordWitnessObservation({
  stateDir, ...options, verdict: 'violation', detail: 'dispatcher bypassed gate', now: new Date(at), ...fields,
});

test('doctor reports an unobserved witness as ok', async (t) => {
  const { host } = await installedFixture(t);
  const result = await runDoctor(host);
  assert.deepEqual(witnessCheck(result), {
    key: 'handbackWitness', status: 'ok',
    value: 'Not observed yet — a handback is seen only when a dispatcher runs in an interactive session.',
  });
});

test('doctor warns after a recorded current-host dispatcher violation without changing exit code', async (t) => {
  const { host } = await installedFixture(t);
  const baseline = await runDoctor(host);
  const stateDir = brandStateDir(host.brandRoot);
  await alarm(stateDir);
  assert.equal(entryState(readHandbackWitness({ stateDir }).ledger.entries[witnessKey(options)]), 'violation');
  const result = await runDoctor(host);
  const witness = witnessCheck(result);
  assert.equal(witness.status, 'warn');
  assert.match(witness.value, /tools-outside-gate \/ codex-build: dispatcher bypassed gate at 2026-09-24T10:00:00/);
  assert.equal(result.exitCode, baseline.exitCode);
});

test('doctor reports a recovered current-host violation as ok with history', async (t) => {
  const { host } = await installedFixture(t);
  const stateDir = brandStateDir(host.brandRoot);
  await alarm(stateDir);
  await alarm(stateDir, { verdict: 'match', now: new Date('2026-09-24T11:00:00.000Z') });
  assert.equal(entryState(readHandbackWitness({ stateDir }).ledger.entries[witnessKey(options)]), 'recovered');
  const witness = witnessCheck(await runDoctor(host));
  assert.equal(witness.status, 'ok');
  assert.match(witness.value, /History: 1 recovered entries/);
});

test('doctor reports a violation only on another host as historical and ok', async (t) => {
  const { host } = await installedFixture(t);
  await alarm(brandStateDir(host.brandRoot), { hostVersion: '2.1.280' });
  const witness = witnessCheck(await runDoctor(host));
  assert.equal(witness.status, 'ok');
  assert.match(witness.value, /1 unresolved entries on other hosts \(historical, not current\)/);
});

test('doctor reports an intercepted handback only on another host as ok and unobserved', async (t) => {
  const { host } = await installedFixture(t);
  await recordInterceptedAttempt({ stateDir: brandStateDir(host.brandRoot), hostVersion: '2.1.280' });
  const witness = witnessCheck(await runDoctor(host));
  assert.equal(witness.status, 'ok');
  assert.match(witness.value, /^Not observed yet/);
});

test('doctor reports the current-host intercepted handback as ok', async (t) => {
  const { host } = await installedFixture(t);
  await recordInterceptedAttempt({ stateDir: brandStateDir(host.brandRoot), hostVersion, now: new Date(at) });
  const witness = witnessCheck(await runDoctor(host));
  assert.equal(witness.status, 'ok');
  assert.equal(witness.value, `Newest intercepted handback on host ${hostVersion} at ${at}.`);
});

test('doctor reports 13 legacy untyped alarms as history and ok', async (t) => {
  const { host } = await installedFixture(t);
  const stateDir = brandStateDir(host.brandRoot);
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(path.join(stateDir, WITNESS_FILE), JSON.stringify({ lastSeen: {}, alarms:
    Array.from({ length: 13 }, (_, index) => ({ hostVersion, at, detail: `host omitted agent_type for agent old-${index}` })),
  }));
  const witness = witnessCheck(await runDoctor(host));
  assert.equal(witness.status, 'ok');
  assert.match(witness.value, /13 older alarms without dispatcher evidence, kept for history/);
  assert.equal(witness.value.match(/History:/g)?.length, 1);
});

test('doctor warns about an unreadable witness without changing exit code', async (t) => {
  const { host } = await installedFixture(t);
  const baseline = await runDoctor(host);
  const stateDir = brandStateDir(host.brandRoot);
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(path.join(stateDir, WITNESS_FILE), '{ broken');
  const result = await runDoctor(host);
  assert.equal(witnessCheck(result).status, 'warn');
  assert.match(witnessCheck(result).value, /handback witness is unreadable/);
  assert.equal(result.exitCode, baseline.exitCode);
});
