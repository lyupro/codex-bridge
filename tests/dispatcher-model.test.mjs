/** Guards Plan_67 D4/D5/D8/D10: observed models and sequence-based quota recovery. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  DISPATCHER_MODEL_FILE, modelLatch, modelObservation, readDispatcherModel,
  recordDispatcherModel, transcriptModels,
} from '../src/home/lib/dispatcher-model.mjs';
import { emptyLedger, reduceObservation } from '../src/home/lib/observation-ledger.mjs';
import { withTempTree } from './temp-tree.mjs';

const agentType = 'codex-build';
const now = '2026-10-07T12:00:00.000Z';
const observe = (changes = {}) => modelObservation({
  agentType, hostVersion: 'host-a', pin: { family: 'haiku' },
  models: ['claude-haiku-4-5-20251001'], ...changes,
});

test('transcriptModels preserves every assistant model and skips malformed or unrelated records', async () => {
  await withTempTree('dispatcher-model-transcript-', (root) => {
    const file = path.join(root, 'agent.jsonl');
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'user', message: { role: 'user', model: 'sonnet' } }),
      JSON.stringify({ type: 'assistant', message: { model: 'haiku' } }),
      '{malformed',
      JSON.stringify({ message: { role: 'assistant', model: 'claude-sonnet-4-5' } }),
      JSON.stringify({ type: 'assistant', message: { model: '<synthetic>' } }),
      JSON.stringify({ type: 'assistant', message: { model: 'haiku' } }),
      JSON.stringify({ type: 'assistant', message: { model: 12 } }),
      JSON.stringify({ type: 'assistant' }),
      'null', '',
    ].join('\r\n'));
    assert.deepEqual(transcriptModels(file), ['haiku', 'claude-sonnet-4-5', '<synthetic>', 'haiku']);
    fs.writeFileSync(file, '');
    assert.deepEqual(transcriptModels(file), []);
  });
});

test('transcriptModels returns null for missing or unreadable transcripts', async () => {
  await withTempTree('dispatcher-model-unreadable-', (root) => {
    assert.equal(transcriptModels(path.join(root, 'missing.jsonl')), null);
    assert.equal(transcriptModels(root), null);
    assert.equal(transcriptModels(undefined), null);
  });
});

test('modelObservation matches by family while retaining unparsed evidence counts', () => {
  const result = observe({ models: ['claude-haiku-4-5', 'claude-3-5-haiku-20241022', '<synthetic>'] });
  assert.equal(result.key, 'host-a|codex-build');
  assert.equal(result.verdict, 'match');
  assert.deepEqual(result.data, {
    hostVersion: 'host-a', agentType, pinFamily: 'haiku',
    parsed: ['haiku'], unparsed: 1, comparison: 'installed-contract',
  });
});

test('any foreign parsed family is a violation against the installed contract', () => {
  const result = observe({ models: ['haiku', 'sonnet', '<synthetic>', 'sonnet'] });
  assert.equal(result.verdict, 'violation');
  assert.equal(result.detail, 'codex-build ran on haiku, sonnet while the installed contract pins haiku');
  assert.deepEqual(result.data.parsed, ['haiku', 'sonnet']);
  assert.equal(result.data.unparsed, 1);
  assert.doesNotMatch(result.detail, /ignored|frontmatter/);
});

test('an undetermined pin retains its reasons and uses the unknown host key', () => {
  const reasons = ['Installed owners disagree.'];
  const result = observe({ hostVersion: null, pin: { family: null, reasons }, models: ['sonnet'] });
  assert.equal(result.key, 'unknown|codex-build');
  assert.equal(result.verdict, 'undetermined');
  assert.equal(result.data.hostVersion, null);
  assert.equal(result.data.pinFamily, null);
  assert.deepEqual(result.data.pinReasons, reasons);
  assert.equal(result.data.comparison, 'installed-contract');
  assert.deepEqual(result.data.parsed, ['sonnet']);
});

test('unparsed or unreadable model evidence cannot confirm a match or violation', () => {
  for (const models of [null, [], ['<synthetic>', 'proxy2']]) {
    const result = observe({ models });
    assert.equal(result.verdict, 'undetermined');
    assert.deepEqual(result.data.parsed, []);
    assert.equal(result.data.unparsed, models?.length ?? 0);
  }
});

test('modelLatch releases only on a later match of its type, across hosts and independent of time', () => {
  let ledger = emptyLedger();
  const add = (observation) => {
    ledger = reduceObservation(ledger, { ...observation, at: now });
    return modelLatch({ ledger, agentType });
  };
  assert.deepEqual(modelLatch({ ledger, agentType }), { active: false, violation: null });
  let latch = add(observe({ models: ['sonnet'] }));
  const firstViolation = latch.violation;
  assert.equal(latch.active, true);
  latch = add(observe({ models: null }));
  assert.equal(latch.active, true);
  assert.deepEqual(latch.violation, firstViolation);
  latch = add(observe({ agentType: 'codex-review' }));
  assert.equal(latch.active, true, 'another type cannot release the latch');
  latch = add(observe({ hostVersion: 'host-b' }));
  assert.equal(latch.active, false, 'a later match on another host releases the type');
  assert.deepEqual(latch.violation, firstViolation, 'recovery preserves the violation');
  latch = add(observe({ agentType: 'codex-review', models: ['sonnet'] }));
  assert.equal(latch.active, false, 'another type cannot reactivate the latch');
  latch = add(observe({ hostVersion: 'host-c', models: ['opus'] }));
  assert.equal(latch.active, true);
  assert.equal(latch.violation.data.hostVersion, 'host-c');
  assert.ok(latch.violation.seq > firstViolation.seq);
  latch = add(observe({ hostVersion: 'host-d', pin: { family: null, reasons: ['Missing owner.'] } }));
  assert.equal(latch.active, true, 'an undetermined pin also cannot release the latch');
});

test('record/read round trip uses the registered ledger and retains history on recovery', async () => {
  await withTempTree('dispatcher-model-ledger-', async (root) => {
    const stateDir = path.join(root, 'state');
    fs.mkdirSync(stateDir);
    assert.deepEqual(readDispatcherModel({ stateDir }), emptyLedger());
    const written = await recordDispatcherModel({ stateDir, observation: observe({ models: ['sonnet'] }), now });
    assert.deepEqual(readDispatcherModel({ stateDir }), written);
    assert.equal(written.entries['host-a|codex-build'].lastViolation.at, now);
    const recovered = await recordDispatcherModel({ stateDir, observation: observe(), now });
    assert.deepEqual(readDispatcherModel({ stateDir }), recovered);
    assert.equal(recovered.seq, 2);
    assert.equal(recovered.entries['host-a|codex-build'].history.length, 1);
    assert.equal(modelLatch({ ledger: recovered, agentType }).active, false);
    assert.deepEqual(fs.readdirSync(stateDir), [DISPATCHER_MODEL_FILE]);
  });
});

test('malformed ledgers remain corrupt and are never overwritten', async () => {
  await withTempTree('dispatcher-model-corrupt-', async (root) => {
    const stateDir = path.join(root, 'state');
    fs.mkdirSync(stateDir);
    const file = path.join(stateDir, DISPATCHER_MODEL_FILE);
    for (const content of ['{malformed', JSON.stringify({ format: 1, seq: 0, entries: { broken: {} } })]) {
      fs.writeFileSync(file, content);
      assert.deepEqual(readDispatcherModel({ stateDir }), { corrupt: true });
      await assert.rejects(recordDispatcherModel({ stateDir, observation: observe(), now }), /corrupt observation ledger/);
      assert.equal(fs.readFileSync(file, 'utf8'), content);
    }
  });
});
