import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withTempTree } from './temp-tree.mjs';
import { handbackWitnessStatus } from '../cli/handback-witness-check.mjs';
import { emptyLedger, entryState, HISTORY_LIMIT } from '../src/home/lib/observation-ledger.mjs';
import {
  WITNESS_FILE, WITNESS_CAUSES, witnessKey, readHandbackWitness,
  recordWitnessObservation, recordInterceptedAttempt,
} from '../src/home/lib/handback-witness.mjs';

const at = '2026-09-24T10:00:00.000Z';
const empty = () => ({ version: 2, ledger: emptyLedger(), intercepted: {}, legacy: [] });
const identity = (cause = 'missing-ids') => ({ cause, hostVersion: '2.1.281', agentType: 'dispatcher' });
const observe = (stateDir, values) => recordWitnessObservation({ stateDir, ...identity(), now: at, ...values });

function fixture(work) {
  return withTempTree('handback-witness-', async (tree) => {
    const stateDir = path.join(tree, 'state');
    fs.mkdirSync(stateDir);
    return work(stateDir, path.join(stateDir, WITNESS_FILE));
  });
}

test('causes are frozen and keys isolate host, cause and required dispatcher type', () => {
  assert.deepEqual(WITNESS_CAUSES, ['missing-agent-type', 'missing-ids', 'tools-outside-gate']);
  assert.ok(Object.isFrozen(WITNESS_CAUSES));
  assert.throws(() => WITNESS_CAUSES.push('other'), TypeError);
  assert.equal(witnessKey(identity('missing-agent-type')), '2.1.281|missing-agent-type');
  assert.equal(witnessKey({ cause: 'missing-agent-type', hostVersion: null }), 'unknown|missing-agent-type');
  assert.equal(witnessKey({ cause: 'missing-agent-type' }), 'unknown|missing-agent-type');
  for (const cause of WITNESS_CAUSES.slice(1)) {
    assert.equal(witnessKey(identity(cause)), `2.1.281|dispatcher|${cause}`);
    assert.equal(witnessKey({ ...identity(cause), hostVersion: null }), `unknown|dispatcher|${cause}`);
    for (const agentType of [undefined, null, '', 123]) {
      assert.throws(() => witnessKey({ ...identity(cause), agentType }), TypeError);
    }
  }
  assert.throws(() => witnessKey({ ...identity(), cause: 'other' }), TypeError);
  assert.throws(() => witnessKey({ ...identity(), hostVersion: 123 }), TypeError);
});

test('missing witness reads as version 2 without creating a file', async () => {
  await fixture((stateDir, file) => {
    assert.deepEqual(readHandbackWitness({ stateDir }), empty());
    assert.equal(fs.existsSync(file), false);
    assert.deepEqual(fs.readdirSync(stateDir), []);
  });
});

test('every intercepted attempt updates its timestamp without creating a match', async () => {
  await fixture(async (stateDir) => {
    let record = await recordInterceptedAttempt({ stateDir, hostVersion: '2.1.281', now: at });
    assert.deepEqual(record, { ...empty(), intercepted: { '2.1.281': at } });
    record = await recordInterceptedAttempt({ stateDir, hostVersion: '2.1.281', now: '2026-09-24T11:00:00Z' });
    assert.equal(record.intercepted['2.1.281'], '2026-09-24T11:00:00.000Z');
    record = await recordInterceptedAttempt({ stateDir, hostVersion: null, now: at });
    assert.equal(record.intercepted.unknown, at);
    assert.deepEqual(record.ledger, emptyLedger());
    assert.deepEqual(readHandbackWitness({ stateDir }), record);
  });
});

for (const cause of WITNESS_CAUSES) {
  test(`${cause}: only a later match for the same key recovers a violation`, async () => {
    await fixture(async (stateDir) => {
      const data = { ...identity(cause), agentType: cause === 'missing-agent-type' ? null : 'dispatcher' };
      const key = witnessKey(data);
      let record = await observe(stateDir, { ...data, verdict: 'violation', detail: 'contract broken' });
      assert.equal(entryState(record.ledger.entries[key]), 'violation');
      assert.deepEqual(record.ledger.entries[key].lastViolation.data, data);
      await recordInterceptedAttempt({ stateDir, hostVersion: data.hostVersion, now: '2026-09-25T00:00:00Z' });
      record = await observe(stateDir, { ...data, verdict: 'undetermined' });
      assert.equal(entryState(record.ledger.entries[key]), 'violation');
      assert.equal(record.ledger.entries[key].lastMatch, null);
      record = await observe(stateDir, { ...data, hostVersion: '2.1.282', verdict: 'match' });
      assert.equal(entryState(record.ledger.entries[key]), 'violation');
      if (cause !== 'missing-agent-type') {
        record = await observe(stateDir, { ...data, agentType: 'other-dispatcher', verdict: 'match' });
        assert.equal(entryState(record.ledger.entries[key]), 'violation');
      }
      const otherCause = cause === 'missing-ids' ? 'tools-outside-gate' : 'missing-ids';
      record = await observe(stateDir, { cause: otherCause, verdict: 'match' });
      assert.equal(entryState(record.ledger.entries[key]), 'violation');
      // D8 orders evidence by ledger sequence, not display timestamps.
      record = await observe(stateDir, { ...data, verdict: 'match', now: '2026-09-23T00:00:00Z' });
      const entry = record.ledger.entries[key];
      assert.equal(entryState(entry), 'recovered');
      assert.equal(entry.lastViolation.detail, 'contract broken');
      assert.ok(entry.lastMatch.seq > entry.lastViolation.seq);
      record = await observe(stateDir, { ...data, verdict: 'undetermined' });
      assert.equal(entryState(record.ledger.entries[key]), 'recovered');
      record = await observe(stateDir, { ...data, verdict: 'violation' });
      assert.equal(entryState(record.ledger.entries[key]), 'violation');
    });
  });
}

test('ledger owns bounded violation history and keeps the last match', async () => {
  await fixture(async (stateDir) => {
    await observe(stateDir, { verdict: 'match', detail: 'confirmed' });
    for (let index = 0; index <= HISTORY_LIMIT; index += 1) {
      await observe(stateDir, { verdict: 'violation', detail: `violation-${index}` });
    }
    const entry = readHandbackWitness({ stateDir }).ledger.entries[witnessKey(identity())];
    assert.equal(entry.history.length, HISTORY_LIMIT);
    assert.equal(entry.history[0].detail, 'violation-1');
    assert.equal(entry.history.at(-1).detail, `violation-${HISTORY_LIMIT}`);
    assert.equal(entry.lastMatch.detail, 'confirmed');
  });
});

test('both writers share the witness lock without losing observations or interceptions', async () => {
  await fixture(async (stateDir) => {
    await Promise.all(Array.from({ length: 6 }, (_, index) => [
      observe(stateDir, { verdict: 'violation', detail: `parallel-${index}` }),
      recordInterceptedAttempt({ stateDir, hostVersion: `host-${index}`, now: at }),
    ]).flat());
    const record = readHandbackWitness({ stateDir });
    const entry = record.ledger.entries[witnessKey(identity())];
    assert.equal(record.ledger.seq, 6);
    assert.equal(Object.keys(record.intercepted).length, 6);
    assert.deepEqual(entry.history.map(({ seq }) => seq), [1, 2, 3, 4, 5, 6]);
    assert.equal(new Set(entry.history.map(({ detail }) => detail)).size, 6);
    assert.equal(entry.lastMatch, null);
  });
});

test('invalid observation arguments fail loudly without publishing a witness', async () => {
  await fixture(async (stateDir, file) => {
    for (const values of [
      { cause: 'other', verdict: 'violation' },
      { agentType: null, verdict: 'violation' },
      { hostVersion: undefined, verdict: 'violation' },
      { hostVersion: 123, verdict: 'violation' },
      { cause: 'missing-agent-type', agentType: 123, verdict: 'violation' },
      { verdict: 'other' }, { verdict: undefined }, { verdict: 'violation', detail: null },
    ]) {
      await assert.rejects(observe(stateDir, values), TypeError);
      assert.equal(fs.existsSync(file), false);
    }
    await assert.rejects(observe(stateDir, { verdict: 'violation', now: 'bad time' }), RangeError);
    await assert.rejects(recordInterceptedAttempt({ stateDir, hostVersion: undefined }), TypeError);
    await assert.rejects(recordInterceptedAttempt({ stateDir, hostVersion: null, now: 'bad time' }), RangeError);
    assert.equal(fs.existsSync(file), false);
  });
});

test('corrupt files refuse both writers and retain their original bytes', async () => {
  await fixture(async (stateDir, file) => {
    for (const source of ['{bad json', 'null', '{}', JSON.stringify({ ...empty(), ledger: { format: 1 } })]) {
      fs.writeFileSync(file, source);
      assert.deepEqual(readHandbackWitness({ stateDir }), { corrupt: true });
      await assert.rejects(observe(stateDir, { verdict: 'violation' }), /Cannot update corrupt observation ledger/);
      await assert.rejects(recordInterceptedAttempt({ stateDir, hostVersion: null }), /Cannot update corrupt observation ledger/);
      assert.equal(fs.readFileSync(file, 'utf8'), source);
      assert.deepEqual(fs.readdirSync(stateDir), [WITNESS_FILE]);
    }
  });
});

test('witness reads validate adapter data in every observation slot without throwing', async () => {
  await fixture(async (stateDir, file) => {
    await observe(stateDir, { verdict: 'violation' });
    const valid = await observe(stateDir, { verdict: 'match' });
    for (const slot of ['lastObservation', 'lastViolation', 'lastMatch', 'history']) {
      for (const data of [undefined, null, [], {}, { ...identity(), cause: 'foreign' },
        { ...identity(), hostVersion: 123 }, { ...identity(), agentType: 123 }]) {
        const record = JSON.parse(JSON.stringify(valid));
        const entry = record.ledger.entries[witnessKey(identity())];
        const observation = slot === 'history' ? entry.history[0] : entry[slot];
        if (data === undefined) delete observation.data;
        else observation.data = data;
        fs.writeFileSync(file, JSON.stringify(record));
        const read = readHandbackWitness({ stateDir });
        assert.deepEqual(read, { corrupt: true }, `${slot}: ${JSON.stringify(data)}`);
        const status = handbackWitnessStatus({ record: read, activeHosts: [identity().hostVersion], stateDir });
        assert.equal(status.state, 'unreadable');
        assert.ok(status.message.includes(file));
      }
    }
  });
});
