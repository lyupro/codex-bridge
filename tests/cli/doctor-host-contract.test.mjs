/** Verifies doctor and installer decisions driven by the version-bound host contract. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diagnose, renderDoctor } from '../../cli/doctor.mjs';
import { contractStatus } from '../../cli/host-contract.mjs';
import { install } from '../../cli/install.mjs';
import { codexProbe, installedFixture, ownPackage } from './doctor-fixtures.mjs';
import { fixture } from './host-fixture.mjs';

const VERSION = '2.1.240';
const CHECKED_AT = '2026-08-23T12:00:00.000Z';

const cases = [
  { state: 'unknown-host', contractRecord: null, hostVersion: null, status: 'warn' },
  { state: 'unverified', contractRecord: null, hostVersion: VERSION, status: 'warn' },
  {
    state: 'stale',
    contractRecord: { hosts: { '2.1.231': { result: 'honored', checkedAt: CHECKED_AT } } },
    hostVersion: VERSION,
    status: 'warn',
  },
  {
    state: 'ignored',
    contractRecord: { hosts: { [VERSION]: { result: 'ignored', checkedAt: CHECKED_AT } } },
    hostVersion: VERSION,
    status: 'fail',
  },
  {
    state: 'verified',
    contractRecord: { hosts: { [VERSION]: { result: 'honored', checkedAt: CHECKED_AT } } },
    hostVersion: VERSION,
    status: 'ok',
  },
];

for (const item of cases) {
  test(`doctor maps ${item.state} host contract to ${item.status}`, async (t) => {
    const { host } = await installedFixture(t);
    const expected = contractStatus({ record: item.contractRecord, version: item.hostVersion });
    const result = await diagnose({
      host,
      codexProbe,
      currentPackage: ownPackage,
      contractRecord: item.contractRecord,
      hostVersion: item.hostVersion,
    });
    const actual = result.checks.find((check) => check.key === 'hostContract');

    assert.equal(expected.state, item.state);
    assert.deepEqual(actual, { key: 'hostContract', status: item.status, value: expected.message });
    assert.equal(result.exitCode, item.state === 'ignored' ? 1 : 0);
    if (item.status === 'warn') {
      const line = renderDoctor(result).split('\n').find((entry) => entry.includes('hostContract:'));
      assert.match(line, /^\u001b\[33m/);
      assert.match(line, /\u001b\[0m$/);
    }
  });
}

test('installer appends only a non-verified host contract message', async (t) => {
  const { host } = await fixture(t);
  const verifiedRecord = { hosts: { [VERSION]: { result: 'honored', checkedAt: CHECKED_AT } } };
  const verified = await install({
    host,
    dryRun: true,
    contractRecord: verifiedRecord,
    hostVersion: VERSION,
  });
  const unverifiedStatus = contractStatus({ record: null, version: VERSION });
  const unverified = await install({
    host,
    dryRun: true,
    contractRecord: null,
    hostVersion: VERSION,
  });

  assert.equal(unverified.output, `${verified.output}\n${unverifiedStatus.message}`);
  assert.doesNotMatch(verified.output, /refusal contract/);
});

test('doctor judges the newest observed host and reports the other host', async (t) => {
  const { host } = await installedFixture(t);
  const observations = { hosts: {
    '2.1.282': { lastSeen: '2026-09-25T12:00:00.000Z' },
    '2.1.281': { lastSeen: '2026-09-24T12:00:00.000Z' },
  } };
  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage, observations,
    contractRecord: { hosts: { '2.1.282': { result: 'honored', checkedAt: CHECKED_AT } } } });
  assert.equal(result.checks.find((item) => item.key === 'hostContract').value,
    contractStatus({ record: { hosts: { '2.1.282': { result: 'honored', checkedAt: CHECKED_AT } } }, version: '2.1.282' }).message);
  assert.ok(result.checks.some((item) => item.key === 'otherHost:2.1.281'));
  assert.match(result.checks.find((item) => item.key === 'sessionHost').value, /also seen: 2\.1\.281/);
});

test('doctor warns when no session host has been observed', async (t) => {
  const { host } = await installedFixture(t);
  const result = await diagnose({ host, codexProbe, currentPackage: ownPackage, observations: { hosts: {} } });
  assert.equal(result.checks.find((item) => item.key === 'sessionHost').status, 'warn');
  assert.deepEqual(result.checks.find((item) => item.key === 'hostContract'), {
    key: 'hostContract', status: 'warn', value: contractStatus({ record: null, version: null }).message,
  });
});

test('installer uses the session-host guidance when no host was observed', async (t) => {
  const { host } = await fixture(t);
  const result = await install({ host, dryRun: true, observations: { hosts: {} } });
  assert.ok(result.output.endsWith('Host contracts are judged once a session has run a shell command; then run codex-bridge doctor.'));
});
