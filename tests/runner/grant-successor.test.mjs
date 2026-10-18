/** Plan_80 E18 O6c: stale parent grants explain the automatic successor without enabling recovery. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import { startedRuns } from '../../src/home/lib/write-meta.mjs';
import { recoverySuccessor } from '../../src/home/lib/meta/recovery-successor.mjs';
import { CONTINUATION_ORDER_INPUT } from '../../src/home/lib/order-schema.mjs';
import { orderRuleMessage } from '../../src/home/lib/order-rules.mjs';
import {
  continuationRefusal, retryRefusal, resumeRefusal, readyGrantLines, sameRun,
} from '../../src/home/lib/runner/continuation.mjs';
import {
  automaticSuccessorOf, lastRunHints, lastRunOutcome,
  readyGrantLines as outcomeReadyGrantLines, sameRun as outcomeSameRun,
} from '../../src/home/lib/runner/continuation-outcome.mjs';

const timestamp = '2026-10-16T09:25:00.000Z';
const suffix = ' The run folder was not created; quota was not spent.';
const grant = { run: 'A', reason: 'finish advice' };
const options = {
  agent: 'codex-advisor', phase: 'advise', liveness: () => false,
  readSession: () => ({ state: 'observed', last_record_at: timestamp }),
};
const failed = {
  status: 'FAIL', reason: 'capacity', result_ok: false, session_id: 'same-thread',
  stop: { version: 2, tree_stop: { state: 'stopped' },
    session: { state: 'observed', last_record_at: timestamp } },
};

function writeRun(root, name, status, meta, started = true) {
  const directory = path.join(root, name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'status.json'), JSON.stringify(status) + '\n');
  fs.writeFileSync(path.join(directory, 'meta.json'), JSON.stringify(meta) + '\n');
  if (started) fs.writeFileSync(path.join(directory, 'heartbeat'), timestamp + '\n');
  return directory;
}

function fixture(t, started = true) {
  const root = makeTempTree('grant-successor-');
  t.after(() => removeTempTree(root));
  const identity = { order_id: 'o', agent: 'codex-advisor', phase: 'advise',
    slug: 'task', repo: root, task_hash: 'task-hash', task_hash_scheme: 'v1' };
  const parent = { ...identity, state: 'finished', started_at: '2026-10-16T09:00:00.000Z',
    recovery: { automatic: true, child: 'B' } };
  const child = { ...identity, state: started ? 'running' : 'abandoned',
    started_at: '2026-10-16T09:30:00.000Z', resumed_from: 'A',
    recovery: { automatic: true, parent: 'A', attempt: 2 } };
  writeRun(root, 'A', parent, failed);
  writeRun(root, 'B', child, started ? failed : {
    status: 'FAIL', reason: 'abandoned before start', exit: null, session_id: null,
    events_bytes: 0, stderr_bytes: 0, tokens_reported: false,
  }, started);
  return { root, parent, child };
}

function refusals(root, chain) {
  return [
    continuationRefusal(root, chain, true, 'o', grant),
    retryRefusal(root, chain, true, 'o', grant, () => false),
    resumeRefusal(root, chain, 'o', grant, options),
  ];
}

const repairs = 'Last run: B. Outcome: FAIL — capacity. ' +
  'Ready grant line: continue: B — finish advice. ' +
  'Ready retry line: retry: B — capacity (repeats that pass under order o). ' +
  `Example: \`continue: ${CONTINUATION_ORDER_INPUT.example}\`. ` +
  'Action: ask the orchestrator for an explicit grant naming the run and reason; ' +
  'do not invent or reuse a continuation.';

function assertOrdinaryRefusals(root) {
  assert.deepEqual(refusals(root, ['A', 'B']), [
    "`continue:` is refused: grant A is not the LAST run of this task's chain; the current last run is B. " +
      'A continuation is single-use: continuing the last run appends a later run, so the old grant stops ' +
      'matching by itself — no counter or new state is used. ' + repairs + suffix,
    "Retry is refused: grant A is not the LAST run of this task's chain; a retry is single-use." + suffix,
    "Resume is refused: grant A is not the LAST run of this task's chain; a resume is single-use." + suffix,
  ]);
}

test('all three parent grants name the started automatic child with complete repair text', (t) => {
  const { root } = fixture(t);
  const chain = startedRuns(root, ['A', 'B']);
  assert.deepEqual(chain, ['A', 'B']);
  assert.equal(recoverySuccessor(root, 'A').started, true, JSON.stringify(recoverySuccessor(root, 'A')));
  const explanation = "run A was already continued automatically in B, which is now the LAST run of this task's chain; " +
    'name B in the grant instead.';
  assert.deepEqual(refusals(root, chain), [
    '`continue:` is refused: ' + explanation + ' ' + repairs + suffix,
    'Retry is refused: ' + explanation + suffix,
    'Resume is refused: ' + explanation + suffix,
  ]);
  assert.deepEqual(fs.readdirSync(root).sort(), ['A', 'B'], 'a refusal creates no run');
});

test('an abandoned automatic child without Codex evidence leaves parent grants usable', (t) => {
  const { root } = fixture(t, false);
  const successor = recoverySuccessor(root, 'A');
  assert.equal(successor.state, 'valid', JSON.stringify(successor));
  assert.equal(successor.started, false);
  const chain = startedRuns(root, ['A', 'B']);
  assert.deepEqual(chain, ['A']);
  assert.equal(automaticSuccessorOf(root, 'A', 'B'), null);
  assert.deepEqual(refusals(root, chain), [null, null, null]);
});

test('an unrelated later run without a pointer keeps every original refusal byte', (t) => {
  const { root, parent, child } = fixture(t);
  const { recovery: ignoredParent, ...ordinaryParent } = parent;
  const { recovery: ignoredChild, resumed_from: ignoredResume, ...ordinaryChild } = child;
  writeRun(root, 'A', ordinaryParent, failed);
  writeRun(root, 'B', ordinaryChild, failed);
  assert.equal(automaticSuccessorOf(root, 'A', 'B'), null);
  assertOrdinaryRefusals(root);
});

test('invalid automatic pointers keep every original refusal byte', (t) => {
  const { root, parent, child } = fixture(t);
  for (const pointer of [null, {}, { automatic: false, child: 'B' },
    { automatic: true, child: '../B' }, { automatic: true, child: 'missing' }]) {
    writeRun(root, 'A', { ...parent, recovery: pointer }, failed);
    assert.equal(recoverySuccessor(root, 'A').state, 'invalid');
    assert.equal(automaticSuccessorOf(root, 'A', 'B'), null);
    assertOrdinaryRefusals(root);
  }
  writeRun(root, 'A', parent, failed);
  writeRun(root, 'B', { ...child, task_hash: 'other' }, failed);
  assert.equal(recoverySuccessor(root, 'A').state, 'invalid');
  assertOrdinaryRefusals(root);
  const { recovery: ignored, ...unmarkedChild } = child;
  writeRun(root, 'B', unmarkedChild, failed);
  assert.equal(recoverySuccessor(root, 'A').state, 'invalid');
  assertOrdinaryRefusals(root);
});

test('only the actual last folder matches an automatic successor, with shared comparison semantics', (t) => {
  const { root, parent } = fixture(t);
  assert.equal(sameRun, outcomeSameRun);
  assert.equal(automaticSuccessorOf(root, 'A', 'B'), 'B');
  assert.equal(automaticSuccessorOf(root, 'A', './B'), 'B');
  assert.equal(automaticSuccessorOf(root, 'A', 'b'), process.platform === 'win32' ? 'B' : null);
  assert.equal(automaticSuccessorOf(root, 'A', undefined), null);
  assert.equal(automaticSuccessorOf(root, 'A', ''), null);
  writeRun(root, 'C', { ...parent, recovery: undefined }, failed);
  assert.equal(automaticSuccessorOf(root, 'A', 'C'), null);
  assert.equal(refusals(root, ['A', 'B', 'C']).some((text) => text.includes('already continued automatically')), false);
});

test('only a non-empty string successor on not-last selects the new rule wording', () => {
  for (const [key, label] of [['continuation-grant-usable', '`continue:`'],
    ['retry-grant-usable', 'Retry'], ['resume-grant-usable', 'Resume']]) {
    const input = { violation: 'not-last', run: 'A' };
    if (key === 'continuation-grant-usable') Object.assign(input, {
      labelName: label, lastRun: 'B', example: CONTINUATION_ORDER_INPUT.example,
      hints: lastRunHints('', []),
    });
    const original = orderRuleMessage(key, input);
    for (const successor of [undefined, null, '', false, 7, {}]) {
      assert.equal(orderRuleMessage(key, { ...input, successor }), original);
    }
    assert.match(orderRuleMessage(key, { ...input, successor: 'B' }), /already continued automatically in B/);
    const missing = { ...input, violation: 'missing-folder', runsRoot: 'runs' };
    assert.equal(orderRuleMessage(key, { ...missing, successor: 'B' }), orderRuleMessage(key, missing));
  }
});

test('extracted ready grants and last-run hints retain literal bytes and public exports', (t) => {
  const root = makeTempTree('grant-successor-outcome-');
  t.after(() => removeTempTree(root));
  assert.equal(readyGrantLines, outcomeReadyGrantLines);
  assert.equal(lastRunOutcome(root, []), null);
  assert.equal(readyGrantLines(root, []), 'Ready grant line: none (there is no run to continue).');
  assert.equal(lastRunHints(root, []),
    'Last run: none. Outcome: none. Ready grant line: none (there is no run to continue).');
  for (const verdict of ['FAIL', 'LIMIT', 'UNAVAILABLE', 'OK', undefined]) {
    for (const orderId of [' o ', undefined]) {
      writeRun(root, 'B', { state: 'finished', order_id: orderId, reason: 'status reason' },
        { status: verdict, reason: ' capacity ' });
      for (const reason of [undefined, ' finish advice ', ' ']) {
        const continueReason = reason?.trim() || 'capacity';
        const ready = `Ready grant line: continue: B — ${continueReason}.` +
          (verdict && verdict !== 'OK' && orderId
            ? ' Ready retry line: retry: B — capacity (repeats that pass under order o).' : '');
        assert.equal(readyGrantLines(root, ['B'], reason), ready);
        assert.equal(lastRunHints(root, ['B'], reason),
          `Last run: B. Outcome: ${verdict || 'finished'} — capacity. ` + ready);
      }
    }
  }
  writeRun(root, 'B', {}, {});
  assert.equal(lastRunHints(root, ['B']),
    'Last run: B. Outcome: unknown — reason not recorded. ' +
    'Ready grant line: continue: B — reason not recorded.');
});
