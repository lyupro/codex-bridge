/** Covers every operator-visible handback witness state. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handbackWitnessStatus } from '../../cli/handback-witness-check.mjs';

const seen = { lastSeen: { sdkVersion: '0.3.281', at: '2026-09-24T10:00:00.000Z' }, alarms: [] };
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

test('patch mismatch is stale, while an unparsable host skips comparison', () => {
  const stale = handbackWitnessStatus({ record: seen, hostVersion: '2.1.282', stateDir });
  assert.equal(stale.state, 'stale');
  assert.match(stale.message, /SDK 0\.3\.281.*2026-09-24.*host 2\.1\.282/);
  assert.match(stale.message, /run any dispatcher once in an interactive session/);
  assert.equal(handbackWitnessStatus({ record: seen, hostVersion: 'unknown', stateDir }).state, 'seen');
});

test('matching patch is seen', () => {
  const result = handbackWitnessStatus({ record: seen, hostVersion: '2.1.281', stateDir });
  assert.equal(result.state, 'seen');
  assert.match(result.message, /last seen on SDK 0\.3\.281 \(host 2\.1\.281\)/i);
});
