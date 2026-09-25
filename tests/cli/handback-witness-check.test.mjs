/** Covers every operator-visible handback witness state. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handbackWitnessStatus } from '../../cli/handback-witness-check.mjs';

const seen = { lastSeen: { '2.1.281': '2026-09-24T10:00:00.000Z' }, alarms: [] };
const stateDir = 'C:/brand/state';

test('corrupt witness identifies the file to delete', () => {
  const result = handbackWitnessStatus({ record: { corrupt: true }, hostVersion: '2.1.281', stateDir });
  assert.equal(result.state, 'unreadable');
  assert.match(result.message, /handback-witness\.json/);
});

test('alarm outranks stale and reports newest alarm details', () => {
  const record = { ...seen, alarms: [{ detail: 'old', at: 'then' }, { detail: 'new', at: 'now' }] };
  const result = handbackWitnessStatus({ record, hostVersion: '2.1.282', stateDir });
  assert.equal(result.state, 'alarm');
  assert.match(result.message, /2 dispatcher alarm/);
  assert.match(result.message, /new at now/);
  assert.match(result.message, /do not trust a dispatcher answer from that time; see Plan_62 D15/);
});

test('missing observation is unobserved', () => {
  const result = handbackWitnessStatus({ record: { lastSeen: null, alarms: [] }, hostVersion: null, stateDir });
  assert.equal(result.state, 'unobserved');
  assert.match(result.message, /only when a dispatcher runs in an interactive session/);
});

test('different host is stale, including neighboring and unrelated patch numbers', () => {
  const stale = handbackWitnessStatus({ record: seen, hostVersion: '2.1.282', stateDir });
  assert.equal(stale.state, 'stale');
  assert.match(stale.message, /host 2\.1\.281 at 2026-09-24.*not yet on host 2\.1\.282/);
  assert.match(stale.message, /recorded the next time a dispatcher runs/);
  assert.equal(handbackWitnessStatus({ record: { lastSeen: { '9.9.281': '2026-09-24T10:00:00.000Z' }, alarms: [] }, hostVersion: '2.1.281', stateDir }).state, 'stale');
});

test('exact host version is seen', () => {
  const result = handbackWitnessStatus({ record: seen, hostVersion: '2.1.281', stateDir });
  assert.equal(result.state, 'seen');
  assert.equal(result.message, 'Handback contract last seen on host 2.1.281 at 2026-09-24T10:00:00.000Z.');
});
