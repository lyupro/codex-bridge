/** Plan_80 E17 O5c: shared thread freshness and manual grant agreement. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempTree } from '../temp-tree.mjs';
import { RULES } from '../../src/home/lib/order-rules/header-grants.mjs';
import { resumeRefusal } from '../../src/home/lib/runner/continuation.mjs';
import { threadFreshnessGap } from '../../src/home/lib/runner/thread-freshness.mjs';

const startedAt = '2026-10-16T09:00:00.000Z';
const recordedAt = '2026-10-16T09:25:00.000Z';
const currentAt = '2026-10-16T09:26:00.000Z';

function facts() {
  return {
    status: { order_id: 'o', agent: 'codex-advisor', phase: 'advise', started_at: startedAt },
    meta: {
      status: 'FAIL', result_ok: false, session_id: 'failed-thread',
      stop: { version: 2, tree_stop: { state: 'stopped' },
        session: { state: 'observed', last_record_at: recordedAt } },
    },
  };
}

const gaps = [
  ...['not-observed', 'missing', 'unreadable', 'empty', 'unrecognized', 'incomplete'].map((state) => ({
    name: `unobserved current session: ${state}`,
    recorded: recordedAt,
    session: { state, reason: 'synthetic session probe', last_record_at: currentAt },
    expected: { violation: 'thread-unreadable', values: { state, reason: 'synthetic session probe' } },
  })),
  ...[null, undefined, 'not a time'].flatMap((time) => [
    {
      name: `unknown current time: ${time}`,
      recorded: recordedAt,
      session: { state: 'observed', last_record_at: time },
      expected: { violation: 'thread-time-unknown', values: { recordedAt, currentAt: time } },
    },
    {
      name: `unknown recorded time: ${time}`,
      recorded: time,
      session: { state: 'observed', last_record_at: currentAt },
      expected: { violation: 'thread-time-unknown', values: { recordedAt: time, currentAt } },
    },
  ]),
  {
    name: 'current thread advanced after its stop',
    recorded: recordedAt,
    session: { state: 'observed', last_record_at: currentAt },
    expected: { violation: 'thread-advanced-after-stop', values: { recordedAt, currentAt } },
  },
];

test('equal, older and equivalent-offset instants have no gap and use the exact reader inputs', () => {
  for (const time of [recordedAt, '2026-10-16T09:24:00.000Z', '2026-10-16T11:25:00.000+02:00']) {
    const input = facts();
    const before = structuredClone(input);
    const calls = [];
    assert.equal(threadFreshnessGap({ ...input, readSession: (request) => {
      calls.push(request);
      return { state: 'observed', last_record_at: time };
    } }), null);
    assert.deepEqual(calls, [{ threadId: input.meta.session_id, startedAt: input.status.started_at,
      referenceAt: null }]);
    assert.deepEqual(input, before, 'freshness reads must not change the frozen facts');
  }
});

for (const entry of gaps) {
  test(`exact freshness gap and read-only facts: ${entry.name}`, () => {
    const input = facts();
    input.meta.stop.session.last_record_at = entry.recorded;
    const before = structuredClone(input);
    const session = structuredClone(entry.session);
    const calls = [];
    const gap = threadFreshnessGap({ ...input, readSession: (request) => {
      calls.push(request);
      return session;
    } });
    assert.deepEqual(gap, entry.expected);
    assert.deepEqual(calls, [{ threadId: input.meta.session_id, startedAt: input.status.started_at,
      referenceAt: null }]);
    assert.deepEqual(input, before);
    assert.deepEqual(session, entry.session);
  });
}

test('Plan_80 E17 one-owner guard: every freshness gap maps to the unchanged manual refusal', () => {
  const root = makeTempTree('thread-freshness-');
  const runDir = path.join(root, 'B');
  fs.mkdirSync(runDir);
  for (const entry of gaps) {
    const input = facts();
    input.meta.stop.session.last_record_at = entry.recorded;
    fs.writeFileSync(path.join(runDir, 'status.json'), JSON.stringify(input.status) + '\n');
    fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify(input.meta) + '\n');
    const calls = [];
    const readSession = (request) => {
      calls.push(request);
      return structuredClone(entry.session);
    };
    const gap = threadFreshnessGap({ ...input, readSession });
    const refusal = resumeRefusal(root, ['B'], 'o', { run: 'B', reason: 'finish advice' }, {
      agent: 'codex-advisor', phase: 'advise', liveness: () => false, readSession,
    });
    // Existing rule texts describe violations in prose; keep their exact wording (Plan_80 E17).
    assert.equal(refusal, RULES['resume-grant-usable'].message({
      run: 'B', violation: gap.violation, ...gap.values,
    }) + ' The run folder was not created; quota was not spent.', entry.name);
    if (gap.violation === 'thread-unreadable') {
      assert.ok(refusal.includes(gap.values.state), entry.name);
      assert.ok(refusal.includes(gap.values.reason), entry.name);
    } else {
      assert.ok(refusal.includes(`recorded last_record_at ${gap.values.recordedAt}`), entry.name);
      assert.ok(refusal.includes(`current last_record_at ${gap.values.currentAt}`), entry.name);
    }
    assert.deepEqual(calls, Array.from({ length: 2 }, () => ({
      threadId: input.meta.session_id, startedAt: input.status.started_at, referenceAt: null,
    })));
  }
  for (const time of [recordedAt, '2026-10-16T09:24:00.000Z']) {
    const input = facts();
    fs.writeFileSync(path.join(runDir, 'status.json'), JSON.stringify(input.status) + '\n');
    fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify(input.meta) + '\n');
    const readSession = () => ({ state: 'observed', last_record_at: time });
    assert.equal(threadFreshnessGap({ ...input, readSession }), null);
    assert.equal(resumeRefusal(root, ['B'], 'o', { run: 'B', reason: 'finish advice' }, {
      agent: 'codex-advisor', phase: 'advise', liveness: () => false, readSession,
    }), null);
  }
});

test('Plan_80 E17 static guard: continuation delegates freshness without owning the comparison', () => {
  const source = fs.readFileSync(new URL('../../src/home/lib/runner/continuation.mjs', import.meta.url), 'utf8');
  assert.ok(!source.includes('last_record_at'));
  assert.ok(source.split('\n').length - 1 < 212, 'continuation stays below its pre-extraction size');
});
