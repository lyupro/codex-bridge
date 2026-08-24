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
    contractRecord: { version: '2.1.231', result: 'honored', checkedAt: CHECKED_AT },
    hostVersion: VERSION,
    status: 'warn',
  },
  {
    state: 'ignored',
    contractRecord: { version: VERSION, result: 'ignored', checkedAt: CHECKED_AT },
    hostVersion: VERSION,
    status: 'fail',
  },
  {
    state: 'verified',
    contractRecord: { version: VERSION, result: 'honored', checkedAt: CHECKED_AT },
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
  const verifiedRecord = { version: VERSION, result: 'honored', checkedAt: CHECKED_AT };
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
