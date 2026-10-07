import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withTempTree } from './temp-tree.mjs';
import { emptyLedger, entryState, normalizeLedger } from '../src/home/lib/observation-ledger.mjs';
import {
  WITNESS_FILE, migrateWitness, witnessKey, readHandbackWitness,
  recordWitnessObservation, recordInterceptedAttempt,
} from '../src/home/lib/handback-witness.mjs';

const at = '2026-09-24T10:00:00.000Z';
const alarm = (detail, values = {}) => ({ at, hostVersion: '2.1.281', detail, ...values });
const old = (alarms = []) => ({ lastSeen: { '2.1.281': at }, alarms });
const untyped = () => Array.from({ length: 13 }, (_, index) => alarm(
  `host omitted agent_type for agent agent-${index}`,
  { at: new Date(Date.parse(at) + index * 1000).toISOString(), hostVersion: `2.1.${281 + index % 9}` },
));

function fixture(work) {
  return withTempTree('handback-witness-migration-', async (tree) => {
    const stateDir = path.join(tree, 'state');
    fs.mkdirSync(stateDir);
    return work(stateDir, path.join(stateDir, WITNESS_FILE));
  });
}

test('13 untyped alarms across hosts become verbatim unverified legacy history, not violations', () => {
  const alarms = untyped();
  const parsed = old([...alarms].reverse());
  const before = structuredClone(parsed);
  const record = migrateWitness(parsed);
  assert.equal(record.version, 2);
  assert.deepEqual(record.intercepted, parsed.lastSeen);
  assert.deepEqual(record.ledger, emptyLedger());
  assert.deepEqual(record.legacy, alarms.map((entry) => ({ ...entry, disposition: 'legacy-untyped-unverified' })));
  assert.deepEqual(parsed, before);
});

test('supported alarms migrate oldest first with original timestamps, hosts, details and agent types', () => {
  const first = alarm('host omitted session_id or agent_id for dispatcher', { at: '2026-09-24T11:00:00+02:00' });
  const second = alarm('dispatcher run-42: Bash, Read outside the dispatcher gate');
  const third = alarm('host omitted session_id or agent_id for dispatcher', { at: '2026-09-24T12:00:00Z' });
  const fourth = alarm('reviewer run-43: Bash outside the dispatcher gate', { hostVersion: null, at: '2026-09-25T00:00:00Z' });
  const record = migrateWitness(old([third, fourth, second, first]));
  assert.ok(normalizeLedger(record.ledger));
  assert.equal(record.ledger.seq, 4);
  assert.deepEqual(record.legacy, []);
  const idsKey = witnessKey({ cause: 'missing-ids', hostVersion: first.hostVersion, agentType: 'dispatcher' });
  const toolsKey = witnessKey({ cause: 'tools-outside-gate', hostVersion: second.hostVersion, agentType: 'dispatcher' });
  const unknownKey = witnessKey({ cause: 'tools-outside-gate', hostVersion: null, agentType: 'reviewer' });
  const ids = record.ledger.entries[idsKey];
  assert.deepEqual(ids.history.map(({ seq, at: time, detail }) => ({ seq, at: time, detail })), [
    { seq: 1, at: first.at, detail: first.detail }, { seq: 3, at: third.at, detail: third.detail },
  ]);
  for (const [key, original, cause, agentType, seq] of [
    [idsKey, third, 'missing-ids', 'dispatcher', 3],
    [toolsKey, second, 'tools-outside-gate', 'dispatcher', 2],
    [unknownKey, fourth, 'tools-outside-gate', 'reviewer', 4],
  ]) {
    const entry = record.ledger.entries[key];
    assert.equal(entryState(entry), 'violation');
    assert.equal(entry.lastMatch, null);
    assert.deepEqual(entry.lastViolation, {
      seq, verdict: 'violation', at: original.at, detail: original.detail,
      data: { cause, hostVersion: original.hostVersion, agentType },
    });
  }
});

test('unknown details and near-misses remain verbatim unclassified legacy entries', () => {
  const alarms = [
    alarm('unknown old alarm'),
    alarm('prefix host omitted agent_type for agent id'),
    alarm('host omitted agent_type for agent id trailing'),
    alarm('host omitted session_id or agent_id for'),
    alarm('dispatcher: Bash outside the dispatcher gate'),
  ];
  const record = migrateWitness(old(alarms));
  assert.deepEqual(record.ledger, emptyLedger());
  assert.deepEqual(record.legacy, alarms.map((entry) => ({ ...entry, disposition: 'unclassified' })));
});

test('SDK shapes discard SDK sightings and normalize alarms to unknown hosts', () => {
  const alarms = [
    { sdkVersion: '0.3.281', at, detail: 'host omitted agent_type for agent sdk-agent' },
    { sdkVersion: null, at, detail: 'host omitted session_id or agent_id for dispatcher' },
    { sdkVersion: '0.3.282', at, detail: 'dispatcher run: Read outside the dispatcher gate' },
    { sdkVersion: '0.3.281', at, detail: 'old alarm' },
  ];
  for (const lastSeen of [null, { sdkVersion: '0.3.281', at }]) {
    const record = migrateWitness({ lastSeen, alarms });
    assert.deepEqual(record.intercepted, {});
    assert.deepEqual(record.legacy, [
      { at, hostVersion: null, detail: alarms[0].detail, disposition: 'legacy-untyped-unverified' },
      { at, hostVersion: null, detail: alarms[3].detail, disposition: 'unclassified' },
    ]);
    assert.equal(record.ledger.seq, 2);
    for (const cause of ['missing-ids', 'tools-outside-gate']) {
      const key = witnessKey({ cause, hostVersion: null, agentType: 'dispatcher' });
      assert.deepEqual(record.ledger.entries[key].lastViolation.data, { cause, hostVersion: null, agentType: 'dispatcher' });
    }
  }
});

test('migration is pure and idempotent, and validated version 2 passes through', () => {
  const input = old([...untyped(), alarm('host omitted session_id or agent_id for dispatcher')]);
  const before = structuredClone(input);
  const once = migrateWitness(input);
  const twice = migrateWitness(once);
  assert.strictEqual(twice, once);
  assert.deepEqual(migrateWitness(JSON.parse(JSON.stringify(once))), once);
  assert.deepEqual(input, before);
});

test('invalid current, SDK and version-2 shapes fail validation', () => {
  const valid = migrateWitness(old());
  const invalid = [
    null, [], {}, { lastSeen: [], alarms: [] }, { lastSeen: {}, alarms: {} },
    { lastSeen: { host: 123 }, alarms: [] },
    { lastSeen: { sdkVersion: 123, at }, alarms: [] },
    { lastSeen: { at }, alarms: [] },
    { lastSeen: null, alarms: [alarm('not an SDK alarm')] },
    old([{ at, detail: 'missing host' }]),
    old([alarm(123)]), old([alarm('bad host', { hostVersion: 123 })]),
    old([alarm('host omitted session_id or agent_id for dispatcher', { at: 'invalid' })]),
    { ...valid, version: 3 }, { ...valid, ledger: {} },
    { ...valid, ledger: { format: 1, seq: -1, entries: {} } },
    { ...valid, intercepted: [] }, { ...valid, intercepted: { host: 123 } },
    { ...valid, legacy: {} }, { ...valid, legacy: [alarm('no disposition')] },
    { ...valid, legacy: [{ ...alarm('bad disposition'), disposition: 'violation' }] },
    { ...valid, legacy: [{ ...alarm('bad timestamp', { at: 123 }), disposition: 'unclassified' }] },
  ];
  for (const parsed of invalid) assert.equal(migrateWitness(parsed), null, JSON.stringify(parsed));
  // The former normalizer allowed arbitrary string dates for sightings and unknown old alarms.
  assert.ok(migrateWitness({ lastSeen: { host: 'old timestamp' }, alarms: [alarm('unknown', { at: 'old timestamp' })] }));
});

test('reading current and SDK files migrates only in memory, preserving bytes and metadata', async () => {
  await fixture((stateDir, file) => {
    for (const parsed of [old(untyped()), { lastSeen: { sdkVersion: '0.3.281', at }, alarms: [{ sdkVersion: null, at, detail: 'old alarm' }] }]) {
      const source = `\uFEFF${JSON.stringify(parsed, null, 2)}\n`;
      fs.writeFileSync(file, source);
      const before = fs.statSync(file).mtimeMs;
      assert.deepEqual(readHandbackWitness({ stateDir }), migrateWitness(parsed));
      assert.deepEqual(readHandbackWitness({ stateDir }), migrateWitness(parsed));
      assert.equal(fs.readFileSync(file, 'utf8'), source);
      assert.equal(fs.statSync(file).mtimeMs, before);
      assert.deepEqual(fs.readdirSync(stateDir), [WITNESS_FILE]);
    }
  });
});

test('first observation migrates in place, retaining every legacy entry and original sighting', async () => {
  await fixture(async (stateDir, file) => {
    const parsed = old([...untyped(), alarm('unclassified old alarm')]);
    fs.writeFileSync(file, JSON.stringify(parsed));
    const migrated = migrateWitness(parsed);
    const data = { cause: 'missing-ids', hostVersion: '2.1.289', agentType: 'dispatcher' };
    const record = await recordWitnessObservation({ stateDir, ...data, verdict: 'violation', detail: 'new observation', now: at });
    assert.equal(record.version, 2);
    assert.deepEqual(record.legacy, migrated.legacy);
    assert.deepEqual(record.intercepted, parsed.lastSeen);
    assert.deepEqual(record.ledger.entries[witnessKey(data)].lastViolation.data, data);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), record);
    assert.equal(Object.hasOwn(record, 'lastSeen'), false);
    assert.equal(Object.hasOwn(record, 'alarms'), false);
    assert.deepEqual(readHandbackWitness({ stateDir }), record);
  });
});

test('first match follows migrated violations and recovers only its own key', async () => {
  await fixture(async (stateDir, file) => {
    const parsed = old([
      alarm('host omitted session_id or agent_id for dispatcher'),
      alarm('dispatcher run: Bash outside the dispatcher gate'),
    ]);
    fs.writeFileSync(file, JSON.stringify(parsed));
    const data = { cause: 'missing-ids', hostVersion: '2.1.281', agentType: 'dispatcher' };
    const record = await recordWitnessObservation({ stateDir, ...data, verdict: 'match', now: '2026-09-23T00:00:00Z' });
    assert.equal(record.ledger.seq, 3);
    assert.equal(entryState(record.ledger.entries[witnessKey(data)]), 'recovered');
    assert.equal(entryState(record.ledger.entries[witnessKey({ ...data, cause: 'tools-outside-gate' })]), 'violation');
  });
});

test('first intercepted attempt also migrates under the witness lock without a match', async () => {
  await fixture(async (stateDir, file) => {
    const parsed = old([...untyped(), alarm('host omitted session_id or agent_id for dispatcher')]);
    fs.writeFileSync(file, JSON.stringify(parsed));
    const migrated = migrateWitness(parsed);
    const record = await recordInterceptedAttempt({ stateDir, hostVersion: '2.1.289', now: at });
    assert.deepEqual(record.ledger, migrated.ledger);
    assert.deepEqual(record.legacy, migrated.legacy);
    assert.deepEqual(record.intercepted, { ...parsed.lastSeen, '2.1.289': at });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), record);
  });
});
