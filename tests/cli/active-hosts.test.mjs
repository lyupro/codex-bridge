/** Guards Plan_67 D12 after concurrent VS Code hosts 2.1.291 and 2.1.292 were misclassified on 2026-10-07. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ACTIVE_HOST_WINDOW_MS, activeHostVersions } from '../../cli/active-hosts.mjs';

const now = new Date('2026-10-07T12:00:00.000Z');
const host = '2.1.291';
const other = '2.1.292';
const recent = '2026-10-07T11:00:00.000Z';
const older = '2026-10-07T10:00:00.000Z';
const ledger = (version, at) => ({ entries: {
  observation: { lastObservation: { at, data: { hostVersion: version } } },
} });
const sources = [
  ['host lastSeen', (version, at) => ({ observations: { hosts: { [version]: { lastSeen: at } } } })],
  ['session at', (version, at) => ({ observations: { sessions: [{ version, at }] } })],
  ['intercepted handback', (version, at) => ({ witnessRecord: { intercepted: { [version]: at } } })],
  ['witness ledger', (version, at) => ({ witnessRecord: { ledger: ledger(version, at) } })],
  ['model ledger', (version, at) => ({ modelRecord: ledger(version, at) })],
];
const active = (records) => activeHostVersions({ ...records, now });

for (const [name, source] of sources) {
  test(`${name} alone makes a host active`, () => {
    assert.deepEqual(active(source(host, recent)), [host]);
  });
  test(`${name} observes the inclusive 24-hour window`, () => {
    assert.equal(ACTIVE_HOST_WINDOW_MS, 24 * 60 * 60 * 1000);
    for (const [hours, expected] of [[0, [host]], [23, [host]], [24, [host]], [25, []]]) {
      const at = new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();
      assert.deepEqual(active(source(host, at)), expected, `${hours} hours`);
    }
  });
  test(`${name} ignores activity one hour in the future`, () => {
    assert.deepEqual(active(source(host, '2026-10-07T13:00:00.000Z')), []);
  });
  test(`${name} ignores unknown hosts and unparseable or non-ISO times`, () => {
    assert.deepEqual(active(source('unknown', recent)), []);
    for (const at of [null, undefined, '', 'bad time', '10/07/2026', '2026-02-30T12:00:00Z', 123]) {
      assert.deepEqual(active(source(host, at)), [], String(at));
    }
  });
}

test('a future source does not hide valid past activity from the same host', () => {
  const future = '2026-10-07T13:00:00.000Z';
  for (const [name, source] of sources) {
    const records = source(host, future);
    const pastSource = records.modelRecord
      ? { observations: { hosts: { [host]: { lastSeen: recent } } } }
      : { modelRecord: ledger(host, recent) };
    assert.deepEqual(active({ ...records, ...pastSource }), [host], name);
  }
});

test('concurrent hosts are both active, newest activity first regardless of version', () => {
  assert.deepEqual(active({ observations: {
    hosts: { [other]: { lastSeen: older }, [host]: { lastSeen: recent } },
  } }), [host, other]);
});

test('latest activity across all sources determines membership and ordering without duplicates', () => {
  const stale = '2026-10-05T12:00:00.000Z';
  const records = {
    observations: {
      hosts: { [host]: { lastSeen: stale }, [other]: { lastSeen: older } },
      sessions: [{ version: host, at: recent }, { version: host, at: stale }],
    },
    witnessRecord: { intercepted: { [host]: older }, ledger: ledger(other, stale) },
    modelRecord: ledger(host, '2026-10-07T09:00:00.000Z'),
  };
  const before = JSON.stringify(records);
  assert.deepEqual(active(records), [host, other]);
  assert.equal(JSON.stringify(records), before, 'selection must not mutate its input');
});

test('every ledger entry and session contributes activity, including session maps', () => {
  const entries = {
    ...ledger(host, older).entries,
    second: ledger(other, recent).entries.observation,
  };
  for (const records of [
    { witnessRecord: { ledger: { entries } } },
    { modelRecord: { entries } },
    { observations: { sessions: { a: { version: host, at: older }, b: { version: other, at: recent } } } },
  ]) assert.deepEqual(active(records), [other, host]);
});

test('corrupt records cannot contribute activity or suppress a healthy independent source', () => {
  for (const [name, source] of sources) {
    const records = source(host, recent);
    const key = Object.keys(records)[0];
    records[key].corrupt = true;
    assert.deepEqual(active(records), [], name);
    records.modelRecord = ledger(other, recent);
    assert.deepEqual(active(records), [other], name);
  }
  assert.deepEqual(active({ observations: null, witnessRecord: null, modelRecord: null }), []);
  assert.deepEqual(active({ observations: { corrupt: true }, witnessRecord: { corrupt: true },
    modelRecord: { corrupt: true } }), []);
});

test('null, unknown and malformed individual activity records are ignored', () => {
  assert.deepEqual(active({
    observations: {
      hosts: { unknown: { lastSeen: recent }, [host]: null, [other]: { corrupt: true, lastSeen: recent } },
      sessions: [null, { version: null, at: recent }, { version: 'unknown', at: recent },
        { version: host, at: recent, corrupt: true }],
    },
    witnessRecord: {
      intercepted: { unknown: recent },
      ledger: { entries: { a: null, b: { lastObservation: null },
        c: { lastObservation: { at: recent, data: { hostVersion: null } } } } },
    },
    modelRecord: { entries: { a: { corrupt: true, lastObservation: { at: recent, data: { hostVersion: host } } },
      b: { lastObservation: { at: recent, data: { hostVersion: 'unknown' } } } } },
  }), []);
});

test('only lastObservation supplies ledger activity, not retained violation or match history', () => {
  const record = ledger(host, '2026-10-05T12:00:00.000Z');
  record.entries.observation.lastViolation = { at: recent, data: { hostVersion: host } };
  record.entries.observation.lastMatch = { at: recent, data: { hostVersion: host } };
  assert.deepEqual(active({ modelRecord: record }), []);
});

test('ISO offsets are compared by instant and now defaults to the current time', () => {
  assert.deepEqual(active({ modelRecord: ledger(host, '2026-10-07T13:00:00+02:00') }), [host]);
  assert.deepEqual(activeHostVersions({ modelRecord: ledger(host, new Date().toISOString()) }), [host]);
});
