import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  HISTORY_LIMIT, emptyLedger, normalizeLedger, reduceObservation, entryState,
  readLedgerFile, updateLedgerFile, recordObservation,
} from '../src/home/lib/observation-ledger.mjs';
import { writeHomeJsonAtomic } from '../src/home/lib/atomic-json.mjs';
import { stateDirWriter } from '../src/home/lib/home-write.mjs';
import { classifyHomePath, HOME_ARTIFACTS, homeArtifact } from '../src/home/lib/home-registry.mjs';
import { makeTempTree, removeTempTree } from './temp-tree.mjs';

const at = '2026-10-07T12:00:00.000Z';
const observation = (verdict, extra = {}) => ({ key: 'host:type', verdict, at, detail: verdict, ...extra });
const reduce = (ledger, verdict, extra) => reduceObservation(ledger, observation(verdict, extra));

async function fixture(t) {
  const root = makeTempTree('bridge-observation-ledger-');
  t.after(() => removeTempTree(root));
  const stateDir = path.join(root, 'state');
  await fs.mkdir(stateDir);
  return { stateDir, file: path.join(stateDir, 'dispatcher-model.json'), id: 'dispatcher-model' };
}

test('empty ledgers have exactly the versioned shape and independent entries', () => {
  const first = emptyLedger();
  assert.deepEqual(first, { format: 1, seq: 0, entries: {} });
  assert.notEqual(first.entries, emptyLedger().entries);
  assert.equal(normalizeLedger(first), first);
  assert.equal(entryState(undefined), 'unobserved');
  assert.equal(entryState(null), 'unobserved');
});

test('violation, undetermined, match, undetermined, violation preserve confirmed facts', () => {
  let ledger = emptyLedger();
  const verdicts = ['violation', 'undetermined', 'match', 'undetermined', 'violation'];
  const states = ['violation', 'violation', 'recovered', 'recovered', 'violation'];
  for (let index = 0; index < verdicts.length; index += 1) {
    const previous = ledger.entries['host:type'];
    ledger = reduce(ledger, verdicts[index]);
    const entry = ledger.entries['host:type'];
    assert.equal(ledger.seq, index + 1);
    assert.equal(entry.lastObservation.seq, index + 1);
    assert.equal(entry.lastObservation.verdict, verdicts[index]);
    assert.equal(entryState(entry), states[index]);
    assert.equal(normalizeLedger(ledger), ledger);
    if (verdicts[index] === 'undetermined') {
      assert.equal(entry.lastViolation, previous.lastViolation);
      assert.equal(entry.lastMatch, previous.lastMatch);
      assert.equal(entry.history, previous.history);
    }
  }
  const entry = ledger.entries['host:type'];
  assert.equal(entry.lastViolation.seq, 5);
  assert.equal(entry.lastMatch.seq, 3);
  assert.deepEqual(entry.history.map((item) => item.seq), [1, 5]);
});

test('only undetermined observations stay undetermined, and a match stays clean', () => {
  let ledger = reduce(emptyLedger(), 'undetermined');
  assert.equal(entryState(ledger.entries['host:type']), 'undetermined');
  ledger = reduce(ledger, 'undetermined');
  assert.equal(entryState(ledger.entries['host:type']), 'undetermined');
  ledger = reduce(ledger, 'match');
  ledger = reduce(ledger, 'undetermined');
  const entry = ledger.entries['host:type'];
  assert.equal(entryState(entry), 'clean');
  assert.equal(entry.lastViolation, null);
  assert.equal(entry.lastMatch.seq, 3);
  assert.deepEqual(entry.history, []);
});

test('ordering uses seq even when display timestamps go backwards', () => {
  let ledger = reduce(emptyLedger(), 'violation', { at: '2030-01-01T00:00:00Z' });
  ledger = reduce(ledger, 'match', { at: '2020-01-01T00:00:00Z' });
  assert.equal(entryState(ledger.entries['host:type']), 'recovered');
  ledger = reduce(ledger, 'violation', { at: '2010-01-01T00:00:00Z' });
  assert.equal(entryState(ledger.entries['host:type']), 'violation');
});

test('history retains only the newest 20 violations, excluding other observations', () => {
  assert.equal(HISTORY_LIMIT, 20);
  let ledger = emptyLedger();
  for (let index = 0; index < HISTORY_LIMIT + 5; index += 1) {
    ledger = reduce(ledger, 'violation', { detail: `violation ${index}` });
    ledger = reduce(ledger, 'undetermined');
  }
  const entry = ledger.entries['host:type'];
  assert.equal(entry.history.length, HISTORY_LIMIT);
  assert.deepEqual(entry.history.map((item) => item.seq), Array.from({ length: 20 }, (_, index) => 11 + index * 2));
  assert.equal(entry.history[0].detail, 'violation 5');
  assert.equal(entry.history.at(-1), entry.lastViolation);
  assert.equal(normalizeLedger(ledger), ledger);
});

test('reduction leaves the input ledger and caller data untouched', () => {
  const data = { nested: { list: ['original', null, true, 1] } };
  const input = reduce(emptyLedger(), 'violation', { data });
  const snapshot = structuredClone(input);
  Object.freeze(input);
  Object.freeze(input.entries);
  Object.freeze(input.entries['host:type']);
  Object.freeze(input.entries['host:type'].history);
  const next = reduce(input, 'match');
  assert.notEqual(next, input);
  assert.notEqual(next.entries, input.entries);
  assert.notEqual(next.entries['host:type'], input.entries['host:type']);
  assert.deepEqual(input, snapshot);
  data.nested.list[0] = 'changed';
  assert.deepEqual(input, snapshot);
});

test('keys are independent, sequence is shared, and special property names are safe', () => {
  let ledger = reduce(emptyLedger(), 'violation', { key: '__proto__' });
  ledger = reduce(ledger, 'match', { key: 'constructor' });
  ledger = reduce(ledger, 'undetermined', { key: 'other' });
  assert.equal(Object.getPrototypeOf(ledger.entries), Object.prototype);
  assert.equal(entryState(ledger.entries.__proto__), 'violation');
  assert.equal(entryState(ledger.entries.constructor), 'clean');
  assert.equal(entryState(ledger.entries.other), 'undetermined');
  assert.equal(ledger.entries.constructor.lastMatch.seq, 2);
  assert.equal(normalizeLedger(ledger), ledger);
});

test('invalid verdicts and keys throw TypeError without changing the ledger', () => {
  const ledger = emptyLedger();
  for (const verdict of [undefined, null, '', 'alarm', 1, {}]) {
    assert.throws(() => reduceObservation(ledger, observation(verdict)), TypeError);
  }
  for (const key of [undefined, null, '', 1, {}, []]) {
    assert.throws(() => reduce(ledger, 'match', { key }), TypeError);
  }
  assert.deepEqual(ledger, emptyLedger());
});

test('at, detail and optional data enforce the observation contract', () => {
  for (const value of [undefined, null, 1, '', 'yesterday', '2026-10-07', '2026-02-30T00:00:00Z']) {
    assert.throws(() => reduce(emptyLedger(), 'match', { at: value }), TypeError);
  }
  for (const detail of [undefined, null, 1, {}]) {
    assert.throws(() => reduce(emptyLedger(), 'match', { detail }), TypeError);
  }
  const circular = {};
  circular.self = circular;
  for (const data of [null, [], new Date(), { bad: undefined }, { bad: Infinity }, { bad: () => {} }, circular]) {
    assert.throws(() => reduce(emptyLedger(), 'match', { data }), TypeError);
  }
  const ledger = reduce(emptyLedger(), 'match', { detail: '', at: '2026-10-07T14:00:00+02:00', data: {} });
  assert.equal(normalizeLedger(ledger), ledger);
  assert.equal(Object.hasOwn(reduce(emptyLedger(), 'match').entries['host:type'].lastObservation, 'data'), false);
});

test('normalization rejects malformed root fields and entry containers', () => {
  const invalid = [null, [], {}, { ...emptyLedger(), format: 2 }, { ...emptyLedger(), format: '1' },
    ...[-1, 0.5, NaN, Infinity, '0', null].map((seq) => ({ ...emptyLedger(), seq })),
    ...[null, [], 'entries', new Date()].map((entries) => ({ ...emptyLedger(), entries })),
    { ...emptyLedger(), extra: true }, { ...emptyLedger(), entries: { '': {} } },
    { ...emptyLedger(), entries: { key: null } }];
  for (const field of ['format', 'seq', 'entries']) {
    const missing = emptyLedger();
    delete missing[field];
    invalid.push(missing);
  }
  for (const parsed of invalid) assert.equal(normalizeLedger(parsed), null);
});

test('normalization rejects each malformed entry and observation field', () => {
  const valid = reduce(reduce(emptyLedger(), 'match'), 'violation', { data: { nested: ['value'] } });
  assert.equal(normalizeLedger(valid), valid);
  const mutations = [
    (e) => { e.extra = true; },
    (e) => { e.lastObservation = null; },
    (e) => { e.lastViolation = {}; },
    (e) => { e.lastViolation.verdict = 'match'; },
    (e) => { e.lastMatch = []; },
    (e) => { e.lastMatch.verdict = 'violation'; },
    (e) => { e.history = null; },
    (e) => { e.history = {}; },
    (e) => { e.history = Array(HISTORY_LIMIT + 1).fill(e.lastViolation); },
    (e) => { e.history = []; },
    (e) => { e.history[0].verdict = 'undetermined'; },
    (e) => { e.history[0].seq = 0; },
    (e) => { e.history = [e.lastViolation, e.lastViolation]; },
    (e) => { e.lastViolation = null; },
    (e) => { e.lastObservation.seq = 1; },
  ];
  for (const field of ['lastObservation', 'lastViolation', 'lastMatch', 'history']) {
    mutations.push((entry) => { delete entry[field]; });
  }
  for (const slot of ['lastObservation', 'lastViolation', 'lastMatch']) {
    for (const field of ['seq', 'verdict', 'at', 'detail']) {
      mutations.push((entry) => { delete entry[slot][field]; });
    }
    for (const seq of [0, -1, 0.5, 3, '1', NaN, Infinity]) {
      mutations.push((entry) => { entry[slot].seq = seq; });
    }
    mutations.push((entry) => { entry[slot].verdict = 'unknown'; });
    mutations.push((entry) => { entry[slot].at = 'not ISO'; });
    mutations.push((entry) => { entry[slot].detail = null; });
    mutations.push((entry) => { entry[slot].data = []; });
    mutations.push((entry) => { entry[slot].data = { bad: undefined }; });
    mutations.push((entry) => { entry[slot].extra = true; });
  }
  for (const mutate of mutations) {
    // JSON round-trip gives independent slots, as records read from disk have.
    const parsed = JSON.parse(JSON.stringify(valid));
    mutate(parsed.entries['host:type']);
    assert.equal(normalizeLedger(parsed), null, mutate.toString());
  }
});

test('read handles missing files, unreadable paths, invalid JSON and invalid shape', async (t) => {
  const { stateDir, file } = await fixture(t);
  assert.deepEqual(readLedgerFile(file), emptyLedger());
  assert.deepEqual(readLedgerFile(stateDir), { corrupt: true });
  for (const bytes of ['{broken', 'null', '{}']) {
    await fs.writeFile(file, bytes);
    assert.deepEqual(readLedgerFile(file), { corrupt: true });
  }
  const ledger = reduce(emptyLedger(), 'match');
  await fs.writeFile(file, JSON.stringify(ledger));
  assert.deepEqual(readLedgerFile(file), ledger);
});

test('read passes parsed JSON to the migration seam and reports rejected or throwing normalization', async (t) => {
  const { file } = await fixture(t);
  const legacy = { old: 'record' };
  await fs.writeFile(file, JSON.stringify(legacy));
  const migrated = reduce(emptyLedger(), 'match');
  let received;
  assert.equal(readLedgerFile(file, { normalize: (parsed) => { received = parsed; return migrated; } }), migrated);
  assert.deepEqual(received, legacy);
  assert.deepEqual(readLedgerFile(file, { normalize: () => null }), { corrupt: true });
  assert.deepEqual(readLedgerFile(file, { normalize: () => { throw new Error('invalid'); } }), { corrupt: true });
});

test('update publishes the supplied transformation after custom normalization', async (t) => {
  const options = await fixture(t);
  await fs.writeFile(options.file, JSON.stringify({ legacy: true }));
  const next = await updateLedgerFile({
    ...options,
    normalize: (parsed) => { assert.deepEqual(parsed, { legacy: true }); return emptyLedger(); },
    update: (current) => reduce(current, 'match'),
  });
  assert.deepEqual(readLedgerFile(options.file), next);
  assert.deepEqual(await fs.readdir(options.stateDir), ['dispatcher-model.json']);
});

test('corrupt updates name the file, preserve bytes, never invoke update and release the lock', async (t) => {
  const options = await fixture(t);
  for (const bytes of ['{broken\n', '{"format":2}']) {
    await fs.writeFile(options.file, bytes);
    let called = false;
    await assert.rejects(updateLedgerFile({ ...options, update: () => { called = true; } }), (error) => {
      assert.ok(error.message.includes(options.file));
      return true;
    });
    assert.equal(called, false);
    assert.equal(await fs.readFile(options.file, 'utf8'), bytes);
    assert.deepEqual(await fs.readdir(options.stateDir), ['dispatcher-model.json']);
  }
});

test('two concurrent observations on the same file both land with seq 2', async (t) => {
  const options = await fixture(t);
  const results = await Promise.all([
    recordObservation({ ...options, observation: observation('violation', { detail: 'first' }) }),
    recordObservation({ ...options, observation: observation('violation', { detail: 'second' }) }),
  ]);
  assert.deepEqual(results.map((result) => result.seq).sort(), [1, 2]);
  const ledger = readLedgerFile(options.file);
  assert.equal(ledger.seq, 2);
  assert.deepEqual(ledger.entries['host:type'].history.map((item) => item.seq), [1, 2]);
  assert.deepEqual(ledger.entries['host:type'].history.map((item) => item.detail).sort(), ['first', 'second']);
  assert.equal(ledger.entries['host:type'].lastObservation.seq, 2);
  assert.deepEqual(await fs.readdir(options.stateDir), ['dispatcher-model.json']);
});

test('registered model artifact declares primary, lock, temporary and purge consequence', () => {
  const artifact = homeArtifact('dispatcher-model');
  assert.equal(artifact.removal, 'purge-only');
  assert.equal(artifact.consequence, 'Doctor forgets which model each dispatcher type was last observed on and every model violation it recorded.');
  assert.deepEqual(artifact.primary, ['state/dispatcher-model.json']);
  assert.deepEqual(artifact.sides, ['lock', 'atomic-temporary']);
  const index = HOME_ARTIFACTS.findIndex((entry) => entry.id === 'dispatcher-model');
  assert.equal(HOME_ARTIFACTS[index - 1].id, 'handback-witness');
  for (const [suffix, role] of [['', 'primary'], ['.lock', 'lock'], ['.12345678-1234-4234-8234-123456789abc.tmp', 'atomic-temporary']]) {
    assert.deepEqual(classifyHomePath(`state/dispatcher-model.json${suffix}`), { id: 'dispatcher-model', role });
  }
});

test('writer refuses a model file under the wrong artifact id without writing it', async (t) => {
  const options = await fixture(t);
  assert.throws(() => writeHomeJsonAtomic(stateDirWriter(options.stateDir), 'handback-witness', options.file, emptyLedger()));
  await assert.rejects(recordObservation({ ...options, id: 'handback-witness', observation: observation('match') }));
  assert.deepEqual(await fs.readdir(options.stateDir), []);
});
