import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import {
  readHandbackWitness, recordWitnessObservation, recordWitnessObservations, witnessKey, WITNESS_FILE,
} from '../../src/home/lib/handback-witness.mjs';
import { entryState } from '../../src/home/lib/observation-ledger.mjs';
import {
  recordStopWitness, typedStopObservations, untypedStopObservation,
} from '../../src/home/hooks/reply-witness.mjs';
import { withTempTree } from '../temp-tree.mjs';

const hostVersion = 'test-host';
const agentType = 'codex-build';
const agentId = 'test-agent';
const cleanStop = () => ({
  agentType, hostVersion, agentId, hasIds: true,
  state: { handback: 'delivered', runnerFinal: true }, toolUses: [], unseen: [],
});
const toolsObservation = (values) => typedStopObservations(values).find(({ cause }) => cause === 'tools-outside-gate');

for (const via of ['gate-state', 'run-command']) {
  test(`untyped dispatcher evidence via ${via} confirms the missing-type violation`, () => {
    assert.deepEqual(untypedStopObservation({ evidence: { dispatcher: true, via }, hostVersion, agentId }), {
      alarm: true,
      observation: {
        cause: 'missing-agent-type', hostVersion, agentType: null, verdict: 'violation',
        detail: `host omitted agent_type for agent ${agentId}; evidence: ${via}`,
      },
    });
  });
}

for (const reason of ['no-evidence', 'transcript-unreadable']) {
  test(`an untyped stop with ${reason} is undetermined without an alarm`, () => {
    assert.deepEqual(untypedStopObservation({ evidence: { dispatcher: false, reason }, hostVersion, agentId }), {
      alarm: false,
      observation: {
        cause: 'missing-agent-type', hostVersion, agentType: null, verdict: 'undetermined',
        detail: `untyped subagent stop without dispatcher evidence (${reason})`,
      },
    });
  });
}

test('typed stops with both ids match the host type field and host-plus-type ids', () => {
  assert.deepEqual(typedStopObservations({ ...cleanStop(), state: null, toolUses: null }), [
    { cause: 'missing-agent-type', hostVersion, agentType: null, verdict: 'match' },
    { cause: 'missing-ids', hostVersion, agentType, verdict: 'match' },
  ]);
});

test('typed stops without ids violate only missing-ids without claiming a type recovery', () => {
  assert.deepEqual(typedStopObservations({ ...cleanStop(), hasIds: false, state: null, toolUses: null }), [{
    cause: 'missing-ids', hostVersion, agentType, verdict: 'violation',
    detail: `host omitted session_id or agent_id for ${agentType}`,
  }]);
});

test('unseen tools always violate the gate with the existing detail and tool order', () => {
  const values = { ...cleanStop(), unseen: [{ name: 'Bash' }, { name: 'Read' }] };
  assert.deepEqual(toolsObservation(values), {
    cause: 'tools-outside-gate', hostVersion, agentType, verdict: 'violation',
    detail: `${agentType} ${agentId}: Bash, Read outside the dispatcher gate`,
  });
  assert.equal(toolsObservation({ ...values, state: null, toolUses: null }).verdict, 'violation');
});

test('a readable, fully audited, healthy delivered runner stop matches the gate', () => {
  assert.deepEqual(toolsObservation(cleanStop()), {
    cause: 'tools-outside-gate', hostVersion, agentType, verdict: 'match',
  });
  const values = cleanStop();
  assert.equal(toolsObservation({ ...values,
    state: { ...values.state, corrupt: false, auditAlarmed: false, runReceiptConflict: null },
  }).verdict, 'match');
});

for (const [name, overrides] of [
  ['unreadable transcript', { toolUses: null }],
  ['missing state', { state: null }],
  ['undefined state', { state: undefined }],
  ['corrupt state', { state: { handback: 'delivered', runnerFinal: true, corrupt: true } }],
  ['earlier audit alarm', { state: { handback: 'delivered', runnerFinal: true, auditAlarmed: true } }],
  ['denied handback', { state: { runnerFinal: true, handbackAttempts: 1 } }],
  ['undelivered handback', { state: { runnerFinal: true, handback: 'denied' } }],
  ['synthetic gate FAIL', { state: { handback: 'delivered', handbackAttempts: 2 } }],
  ['unfinished runner', { state: { handback: 'delivered', runnerFinal: false } }],
  ['truthy non-boolean runnerFinal', { state: { handback: 'delivered', runnerFinal: 'true' } }],
  ['conflicting runner receipt', { state: { handback: 'delivered', runnerFinal: true, runReceiptConflict: 'other-run' } }],
]) {
  test(`${name} never supplies a tools-outside-gate match`, () => {
    const values = { ...cleanStop(), ...overrides };
    assert.equal(toolsObservation(values), undefined);
    assert.equal(typedStopObservations(values).length, 2);
  });
}

test('one ordered batch preserves violations and allocates successive sequence numbers', async () => {
  await withTempTree('reply-witness-batch-', async (root) => {
    const stateDir = path.join(root, 'state');
    const data = { cause: 'missing-ids', hostVersion, agentType };
    const record = await recordWitnessObservations({
      stateDir, now: '2026-10-07T00:00:00Z', observations: [
        { ...data, verdict: 'violation', detail: 'first' },
        { ...data, verdict: 'undetermined', detail: 'uncertain' },
        { ...data, verdict: 'match', detail: 'last' },
      ],
    });
    const entry = record.ledger.entries[witnessKey(data)];
    assert.equal(record.ledger.seq, 3);
    assert.equal(entryState(entry), 'recovered');
    assert.equal(entry.lastViolation.seq, 1);
    assert.equal(entry.lastMatch.seq, 3);
    assert.equal(entry.lastObservation.detail, 'last');
    assert.equal(entry.lastMatch.at, '2026-10-07T00:00:00.000Z');
    assert.deepEqual(readHandbackWitness({ stateDir }), record);
  });
});

test('an invalid later observation never publishes a partial batch', async () => {
  await withTempTree('reply-witness-invalid-', async (root) => {
    const stateDir = path.join(root, 'state');
    await recordWitnessObservation({ stateDir, cause: 'missing-ids', hostVersion, agentType, verdict: 'violation' });
    const file = path.join(stateDir, WITNESS_FILE);
    const before = await fs.readFile(file, 'utf8');
    await assert.rejects(recordWitnessObservations({ stateDir, observations: [
      { cause: 'missing-ids', hostVersion, agentType, verdict: 'match' },
      { cause: 'missing-ids', hostVersion, agentType, verdict: 'invalid' },
    ] }), TypeError);
    assert.equal(await fs.readFile(file, 'utf8'), before);
  });
});

test('stop matches recover only the same host and the same type for typed causes', async () => {
  await withTempTree('reply-witness-isolation-', async (root) => {
    const stateDir = path.join(root, 'state');
    const causes = ['missing-agent-type', 'missing-ids', 'tools-outside-gate'];
    const keys = causes.map((cause) => witnessKey({ cause, hostVersion, agentType }));
    await recordWitnessObservations({ stateDir, observations: causes.map((cause) => ({
      cause, hostVersion, agentType: cause === 'missing-agent-type' ? null : agentType, verdict: 'violation',
    })) });
    await recordStopWitness({ stateDir, observations: typedStopObservations({ ...cleanStop(), hostVersion: 'other-host' }) });
    for (const key of keys) assert.equal(entryState(readHandbackWitness({ stateDir }).ledger.entries[key]), 'violation');
    await recordStopWitness({ stateDir, observations: typedStopObservations({ ...cleanStop(), agentType: 'codex-review' }) });
    let entries = readHandbackWitness({ stateDir }).ledger.entries;
    assert.equal(entryState(entries[keys[0]]), 'recovered');
    for (const key of keys.slice(1)) assert.equal(entryState(entries[key]), 'violation');
    await recordStopWitness({ stateDir, observations: typedStopObservations(cleanStop()) });
    entries = readHandbackWitness({ stateDir }).ledger.entries;
    for (const key of keys) assert.equal(entryState(entries[key]), 'recovered');
  });
});

test('untyped observations without evidence cannot recover a confirmed violation', async () => {
  await withTempTree('reply-witness-undetermined-', async (root) => {
    const stateDir = path.join(root, 'state');
    for (const evidence of [{ dispatcher: true, via: 'gate-state' }, { dispatcher: false, reason: 'no-evidence' }]) {
      const { observation } = untypedStopObservation({ evidence, hostVersion, agentId });
      await recordStopWitness({ stateDir, observations: [observation] });
    }
    const entry = readHandbackWitness({ stateDir }).ledger.entries[witnessKey({ cause: 'missing-agent-type', hostVersion })];
    assert.equal(entryState(entry), 'violation');
    assert.equal(entry.lastObservation.verdict, 'undetermined');
  });
});

test('witness writer failures are swallowed and corrupt evidence remains untouched', async () => {
  await withTempTree('reply-witness-fail-open-', async (root) => {
    const stateDir = path.join(root, 'state');
    await fs.mkdir(stateDir);
    const file = path.join(stateDir, WITNESS_FILE);
    await fs.writeFile(file, '{broken');
    await recordStopWitness({ stateDir, observations: typedStopObservations(cleanStop()) });
    assert.equal(await fs.readFile(file, 'utf8'), '{broken');
    await recordStopWitness({ stateDir, observations: [{ cause: 'invalid', hostVersion }] });
  });
});
