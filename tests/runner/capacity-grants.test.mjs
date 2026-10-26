/** OW-074 C4: capacity grants avoid the overloaded thread and stop after one retry. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import { grantBlockers, assessStop } from '../../src/home/lib/meta/stop-assessment.mjs';
import { orderRuleMessage } from '../../src/home/lib/order-rules.mjs';
import { retryRefusal, resumeRefusal } from '../../src/home/lib/runner/continuation.mjs';
import { readyGrantLines, lastRunHints } from '../../src/home/lib/runner/continuation-outcome.mjs';

const timestamp = '2026-10-26T09:00:00.000Z';
const stop = {
  trigger: 'deadline', tree_stop: { state: 'stopped' }, stopped_at: timestamp,
  session: { state: 'observed', last_record_at: timestamp,
    at_reference: { commands: { state: 'none', pending: [] } } },
};
const facts = { status: 'CAPACITY', resultOk: false, agentWrites: false, threadId: 'thread', stop };
const identity = { state: 'finished', order_id: 'o', agent: 'codex-advisor', phase: 'advise' };
const grant = (run) => ({ run, reason: 'model changed' });
const suffix = ' The run folder was not created; quota was not spent.';

function fixture(t) {
  const root = makeTempTree('capacity-grants-');
  t.after(() => removeTempTree(root));
  return root;
}

function writeRun(root, name, verdict, extra = {}) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'status.json'), JSON.stringify({ ...identity, ...extra }) + '\n');
  fs.writeFileSync(path.join(directory, 'meta.json'), JSON.stringify({
    status: verdict, result_ok: false, session_id: 'thread', stop, reason: 'model at capacity',
  }) + '\n');
}

test('capacity blocks grants and automatic recovery while retaining stop facts', () => {
  assert.deepEqual(grantBlockers(facts), ['capacity']);
  const assessed = assessStop({ ...facts, silencePolicy: { threshold_ms: 1000 },
    recoveryPolicy: { enabled: true, budget_ms: 1000 } });
  assert.equal(assessed.situation.kind, 'capacity');
  assert.equal(assessed.treatment.action, 'retain-stop-facts');
  assert.equal(assessed.continuation_eligibility.grant.allowed, false);
  assert.deepEqual(assessed.continuation_eligibility.grant.blocking_reasons, ['capacity']);
  assert.equal(assessed.continuation_eligibility.automatic.allowed, false);
  assert.ok(assessed.continuation_eligibility.automatic.blocking_reasons.includes('capacity'));
});

test('resume refuses an otherwise eligible stopped read-only capacity run', (t) => {
  const root = fixture(t);
  writeRun(root, 'A', 'CAPACITY');
  assert.deepEqual(grantBlockers({ ...facts, status: 'FAIL' }), []);
  assert.equal(resumeRefusal(root, ['A'], 'o', grant('A'), {
    agent: 'codex-advisor', phase: 'advise', liveness: () => false,
    readSession: () => assert.fail('capacity must refuse before thread freshness'),
  }), 'Resume is refused: run A cannot be resumed: capacity. A retry: grant repeats it on a fresh thread.' + suffix);
  assert.deepEqual(fs.readdirSync(root), ['A']);
});

test('capacity ready grants contain only the wait or model-change instruction', (t) => {
  const root = fixture(t);
  writeRun(root, 'A', 'CAPACITY', { order_id: ' o ' });
  const expected = "Ready grant line: none after CAPACITY: wait or change this role's model, " +
    'then grant retry for A once under order o; a second CAPACITY goes to the next executor.';
  assert.equal(orderRuleMessage('ready-grant-line', { variant: 'capacity', run: 'A', orderId: 'o' }), expected);
  for (const reason of [undefined, 'finish the pass', ' ']) {
    const ready = readyGrantLines(root, ['A'], reason);
    assert.equal(ready, expected);
    assert.doesNotMatch(ready, /continue:|retry: /);
    assert.ok(lastRunHints(root, ['A'], reason).endsWith(expected));
  }
});

test('capacity without a recorded order has no ready grant', (t) => {
  const root = fixture(t);
  for (const order_id of [undefined, '', ' ']) {
    writeRun(root, 'A', 'CAPACITY', { order_id });
    assert.equal(readyGrantLines(root, ['A']), orderRuleMessage('ready-grant-line', { variant: 'none' }));
  }
});

test('the first retry of a capacity run stays allowed', (t) => {
  const root = fixture(t);
  writeRun(root, 'A', 'CAPACITY');
  assert.equal(retryRefusal(root, ['A'], true, 'o', grant('A'), () => false), null);
  assert.deepEqual(fs.readdirSync(root), ['A']);
});

test('a second consecutive capacity refuses retry before creating a run', (t) => {
  const root = fixture(t);
  writeRun(root, 'A', 'CAPACITY');
  writeRun(root, 'B', 'CAPACITY', { retry_of: 'A' });
  const expected = 'Retry is refused: run B is the second CAPACITY of this order in a row; ' +
    'hand the order to the next executor, and to repeat it later use a new order id.';
  assert.equal(orderRuleMessage('retry-grant-usable', { violation: 'capacity-repeated', run: 'B' }), expected);
  const refusal = retryRefusal(root, ['A', 'B'], true, 'o', grant('B'), () => false);
  assert.equal(refusal, expected + suffix);
  assert.match(refusal, /second CAPACITY/);
  assert.deepEqual(fs.readdirSync(root).sort(), ['A', 'B']);
});

test('capacity following a plain FAIL retry remains retryable', (t) => {
  const root = fixture(t);
  writeRun(root, 'A', 'FAIL');
  writeRun(root, 'B', 'CAPACITY', { retry_of: 'A' });
  assert.equal(retryRefusal(root, ['A', 'B'], true, 'o', grant('B'), () => false), null);
});

test('capacity predecessor does not change other verdicts or bypass earlier gates', (t) => {
  const root = fixture(t);
  writeRun(root, 'A', 'CAPACITY');
  for (const verdict of ['FAIL', 'LIMIT', 'UNAVAILABLE']) {
    writeRun(root, 'B', verdict, { retry_of: 'A' });
    assert.equal(retryRefusal(root, ['A', 'B'], true, 'o', grant('B'), () => false), null);
  }
  writeRun(root, 'B', 'OK', { retry_of: 'A' });
  assert.match(retryRefusal(root, ['A', 'B'], true, 'o', grant('B'), () => false), /ended OK/);
  writeRun(root, 'B', 'CAPACITY', { retry_of: 'A' });
  assert.match(retryRefusal(root, ['A', 'B'], true, 'o', grant('B'), () => true), /worker may still be alive/);
});
