/** Plan_80 E13 O5: recheck frozen safety and current thread facts without spending a pass. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempTree } from '../temp-tree.mjs';
import { resumeRefusal } from '../../src/home/lib/runner/continuation.mjs';

const startedAt = '2026-10-16T09:00:00.000Z';
const recordedAt = '2026-10-16T09:25:00.000Z';
const currentAt = '2026-10-16T09:26:00.000Z';
const suffix = ' The run folder was not created; quota was not spent.';
const identity = "a resume continues the named run's own agent and phase: codex-advisor/advise.";
const unfinished = 'Resume is refused: run B has no finished verdict or its worker may still be alive and writing. ' +
  'Repeat without `resume:` to attach to it.';
const endedOk = "Resume is refused: run B ended OK. A resume continues a failed pass's Codex thread; " +
  'use continue: for the next pass.';
const advanced = 'Resume is refused: run B Codex thread advanced after stop: ' +
  `recorded last_record_at ${recordedAt}; current last_record_at ${currentAt}.`;
const ineligible = (blockers) => `Resume is refused: run B cannot be resumed: ${blockers}. ` +
  'A retry: grant repeats it on a fresh thread.';
const unreadable = (state, reason) => `Resume is refused: run B Codex thread is ${state}; reason: ${reason}.`;

function fixture() {
  const root = makeTempTree('resume-grant-');
  const runDir = path.join(root, 'B');
  fs.mkdirSync(runDir);
  const status = { order_id: 'o', agent: 'codex-advisor', phase: 'advise', started_at: startedAt };
  const meta = {
    status: 'FAIL', result_ok: false, session_id: 'failed-thread',
    stop: { version: 2, tree_stop: { state: 'stopped' },
      session: { state: 'observed', last_record_at: recordedAt } },
  };
  const calls = { liveness: [], readSession: [] };
  const options = {
    agent: 'codex-advisor', phase: 'advise',
    liveness: (input) => { calls.liveness.push(input); return false; },
    readSession: (input) => {
      calls.readSession.push(input);
      return { state: 'observed', last_record_at: recordedAt };
    },
  };
  const write = () => {
    fs.writeFileSync(path.join(runDir, 'status.json'), JSON.stringify(status) + '\n');
    fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify(meta) + '\n');
  };
  const decide = (chain = ['B'], grant = { run: 'B', reason: 'finish advice' }, order = 'o') => {
    write();
    return resumeRefusal(root, chain, order, grant, options);
  };
  return { root, runDir, status, meta, calls, options, write, decide };
}

test('an eligible failed advisor resolves its own thread and status start time', () => {
  const f = fixture();
  assert.equal(f.decide(), null);
  assert.deepEqual(f.calls.liveness, [{ runDir: f.runDir, status: f.status }]);
  assert.deepEqual(f.calls.readSession, [{ threadId: 'failed-thread', startedAt, referenceAt: null }]);
  assert.deepEqual(fs.readdirSync(f.root), ['B'], 'the zero-quota decision creates no run');
});

test('missing-folder refuses missing, non-bare, dot, parent and ordinary-file grants', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.root, 'file'), 'not a run');
  for (const run of ['missing', 'nested/B', '.', '..', 'file', '']) {
    assert.equal(f.decide(['B'], { run, reason: 'finish' }),
      `Resume is refused: ${run || 'none'} is not a bare existing run folder in ${f.root}.` + suffix);
  }
  assert.deepEqual(f.calls.liveness, []);
  assert.deepEqual(f.calls.readSession, []);
});

test('not-last refuses an earlier run and an empty chain, making a grant single-use', () => {
  const f = fixture();
  for (const chain of [['B', 'C'], []]) {
    assert.equal(f.decide(chain),
      "Resume is refused: grant B is not the LAST run of this task's chain; a resume is single-use." + suffix);
  }
});

test('order-mismatch refuses absent, blank and different recorded order ids', () => {
  const f = fixture();
  for (const order of [undefined, '', ' ', 'other']) {
    f.status.order_id = order;
    assert.equal(f.decide(),
      `Resume is refused: run B order_id ${order?.trim() || '(missing)'} differs from order o. ` +
      'A resume continues its own order; a run without order_id predates orders — start a new order.' + suffix);
  }
  f.status.order_id = ' o ';
  assert.equal(f.decide(['B'], { run: 'B', reason: 'finish' }, ' o '), null);
});

test('identity refuses a different agent or phase with the named pass identity', () => {
  const f = fixture();
  for (const change of [{ agent: 'codex-review' }, { phase: 'scope' }]) {
    Object.assign(f.options, { agent: 'codex-advisor', phase: 'advise' }, change);
    assert.equal(f.decide(), identity + suffix);
  }
  assert.deepEqual(f.calls.liveness, []);
});

test('missing and blank phases mean default, matching the retry pass gate', () => {
  const f = fixture();
  f.status.agent = f.options.agent = 'codex-scout';
  for (const phase of [undefined, '', ' ', ' default ']) {
    f.status.phase = phase;
    for (const requested of [undefined, '', ' ', 'default']) {
      f.options.phase = requested;
      assert.equal(f.decide(), null);
    }
  }
  f.options.phase = 'advise';
  assert.equal(f.decide(), "a resume continues the named run's own agent and phase: codex-scout/default." + suffix);
});

test('unfinished refuses a missing meta verdict or a worker that may still be alive', () => {
  const f = fixture();
  delete f.meta.status;
  assert.equal(f.decide(), unfinished + suffix);
  assert.deepEqual(f.calls.liveness, []);
  f.meta.status = 'FAIL';
  f.options.liveness = () => true;
  assert.equal(f.decide(), unfinished + suffix);
  assert.deepEqual(f.calls.readSession, []);
});

test('ended-ok refuses a successful verdict before reading its thread', () => {
  const f = fixture();
  f.meta.status = 'OK';
  assert.equal(f.decide(), endedOk + suffix);
  assert.deepEqual(f.calls.readSession, []);
});

test('not-eligible recomputes every missing-stop blocker and ignores recorded allowed eligibility', () => {
  const f = fixture();
  delete f.meta.stop;
  f.meta.continuation_eligibility = { allowed: true, grant: { allowed: true, blocking_reasons: [] } };
  assert.equal(f.decide(), ineligible('stop-record-missing, session-evidence-not-observed, ' +
    'process-tree-stop-unverified') + suffix);
  assert.deepEqual(f.calls.readSession, []);
});

test('not-eligible lists all applicable blockers in policy order', () => {
  const f = fixture();
  f.status.agent = f.options.agent = 'codex-build';
  f.meta.status = 'LIMIT';
  f.meta.result_ok = true;
  f.meta.session_id = null;
  f.meta.stop.trigger = 'stream-error';
  f.meta.stop.session.state = 'missing';
  f.meta.stop.tree_stop.state = 'unverified';
  assert.equal(f.decide(), ineligible('result-present, limit, runner-error, writer-role-not-approved, ' +
    'thread-unavailable, session-evidence-missing, process-tree-stop-unverified') + suffix);
});

test('codex-build cannot resume when every other eligibility fact passes', () => {
  const f = fixture();
  f.status.agent = f.options.agent = 'codex-build';
  assert.equal(f.decide(), ineligible('writer-role-not-approved') + suffix);
});

test('thread-unreadable names each unobserved current state and its reason', () => {
  const f = fixture();
  for (const state of ['not-observed', 'missing', 'unreadable', 'empty', 'unrecognized', 'incomplete']) {
    f.options.readSession = () => ({ state, reason: 'session probe reason', last_record_at: currentAt });
    assert.equal(f.decide(), unreadable(state, 'session probe reason') + suffix);
  }
});

test('an unparsable recorded or current last record time refuses instead of passing the grant', () => {
  const f = fixture();
  const unknownTime = (recorded, current) => 'Resume is refused: run B Codex thread last record time is unknown: ' +
    `recorded last_record_at ${recorded}; current last_record_at ${current}.`;
  for (const time of [null, undefined, 'not a time']) {
    f.options.readSession = () => ({ state: 'observed', last_record_at: time });
    assert.equal(f.decide(), unknownTime(recordedAt, time) + suffix);
  }
  f.options.readSession = () => ({ state: 'observed', last_record_at: recordedAt });
  f.meta.stop.session.last_record_at = 'garbled';
  assert.equal(f.decide(), unknownTime('garbled', recordedAt) + suffix);
});

test('thread-advanced-after-stop prints both times and compares parsed instants', () => {
  const f = fixture();
  f.options.readSession = () => ({ state: 'observed', last_record_at: currentAt });
  assert.equal(f.decide(), advanced + suffix);
  for (const time of [recordedAt, '2026-10-16T09:24:00.000Z', '2026-10-16T11:25:00.000+02:00']) {
    f.options.readSession = () => ({ state: 'observed', last_record_at: time });
    assert.equal(f.decide(), null);
  }
});

test('Plan_80 E13 O5: adjacent competing violations refuse at the first gate', () => {
  const cases = [
    [(f) => { f.status.order_id = 'wrong'; }, ['B', 'C'], { run: 'missing' },
      (f) => `Resume is refused: missing is not a bare existing run folder in ${f.root}.`],
    [(f) => { f.status.order_id = 'wrong'; }, ['B', 'C'], { run: 'B' },
      () => "Resume is refused: grant B is not the LAST run of this task's chain; a resume is single-use."],
    [(f) => { f.status.order_id = 'wrong'; f.options.agent = 'codex-build'; }, ['B'], { run: 'B' },
      () => 'Resume is refused: run B order_id wrong differs from order o. ' +
        'A resume continues its own order; a run without order_id predates orders — start a new order.'],
    [(f) => { f.options.agent = 'codex-build'; delete f.meta.status; }, ['B'], { run: 'B' }, () => identity],
    [(f) => { f.meta.status = 'OK'; f.options.liveness = () => true; }, ['B'], { run: 'B' }, () => unfinished],
    [(f) => { f.meta.status = 'OK'; delete f.meta.stop; }, ['B'], { run: 'B' }, () => endedOk],
    [(f) => { f.meta.result_ok = true; f.options.readSession = () => assert.fail('must not read'); },
      ['B'], { run: 'B' }, () => ineligible('result-present')],
    [(f) => { f.options.readSession = () => ({ state: 'incomplete', reason: 'partial', last_record_at: currentAt }); },
      ['B'], { run: 'B' }, () => unreadable('incomplete', 'partial')],
  ];
  for (const [arrange, chain, grant, expected] of cases) {
    const f = fixture();
    arrange(f);
    assert.equal(f.decide(chain, grant), expected(f) + suffix);
  }
});
