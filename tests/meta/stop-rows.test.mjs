/** Plan_80 A5: stop explanations must preserve the stored assessments and reply boundaries. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { collect } from '../../src/home/lib/write-meta.mjs';
import { failReply } from '../../src/home/lib/meta/reply.mjs';
import { stopRows } from '../../src/home/lib/meta/stop-rows.mjs';
import { makeRun } from './test-fixtures.mjs';

function storedMeta() {
  return {
    situation: {
      kind: 'silent-stall-candidate', silence_ms: 12345, threshold_ms: 996000,
      commands: { state: 'none' },
    },
    continuation_eligibility: {
      automatic: { allowed: false, blocking_reasons: ['recovery-not-enabled', 'resume-contract-unverified'] },
      grant: { allowed: false, blocking_reasons: ['recovery-not-enabled', 'resume-grant-not-implemented'] },
    },
    treatment: { version: 1, effect: 'diagnostic-only', action: 'retain-stop-facts' },
  };
}

test('renders exactly three rows from stored assessments, without reclassifying or mutating them', () => {
  const meta = storedMeta();
  // Plan_80 A5: even contradictory raw inputs must not replace what the assessments say.
  meta.stop = { trigger: 'spawn-error' };
  meta.silence_policy = { threshold_ms: 1 };
  meta.treatment.action = 'inspect-evidence';
  const before = structuredClone(meta);
  assert.deepEqual(stopRows(meta), [
    'Situation: silent-stall-candidate · silence=12345 ms · threshold=996000 ms · command=none',
    'Continuation: automatic blocked (recovery-not-enabled, resume-contract-unverified) · grant blocked (recovery-not-enabled, resume-grant-not-implemented)',
    'Treatment: inspect-evidence · diagnostic only, nothing runs it',
  ]);
  assert.deepEqual(meta, before);
});

for (const [field, expected] of [
  ['silence_ms', 'Situation: silent-stall-candidate · silence=unknown · threshold=996000 ms · command=none'],
  ['threshold_ms', 'Situation: silent-stall-candidate · silence=12345 ms · threshold=unconfigured · command=none'],
  ['commands', 'Situation: silent-stall-candidate · silence=12345 ms · threshold=996000 ms · command=unknown'],
]) {
  test(`renders the ${field} null placeholder independently`, () => {
    const meta = storedMeta();
    meta.situation[field] = field === 'commands' ? { state: null } : null;
    assert.equal(stopRows(meta)[0], expected);
  });
}

test('zero silence and threshold remain numeric rather than becoming placeholders', () => {
  const meta = storedMeta();
  meta.situation.silence_ms = 0;
  meta.situation.threshold_ms = 0;
  assert.equal(stopRows(meta)[0],
    'Situation: silent-stall-candidate · silence=0 ms · threshold=0 ms · command=none');
});

test('preserves all blocking codes, their stored order and duplicates without truncation', () => {
  const meta = storedMeta();
  meta.continuation_eligibility.automatic.blocking_reasons = [
    'z-stored-first', 'a-stored-second', 'z-stored-first', 'recovery-not-enabled',
    'resume-contract-unverified', 'writer-role-not-approved', 'thread-unavailable',
    'session-evidence-not-observed', 'command-evidence-unknown', 'threshold-unconfigured',
    'process-tree-stop-unverified',
  ];
  meta.continuation_eligibility.grant.blocking_reasons = [
    'recovery-not-enabled', 'resume-grant-not-implemented', 'resume-contract-unverified',
    'writer-role-not-approved', 'thread-unavailable', 'session-evidence-not-observed',
    'command-evidence-unknown', 'process-tree-stop-unverified',
  ];
  assert.equal(stopRows(meta)[1],
    'Continuation: automatic blocked (z-stored-first, a-stored-second, z-stored-first, recovery-not-enabled, resume-contract-unverified, writer-role-not-approved, thread-unavailable, session-evidence-not-observed, command-evidence-unknown, threshold-unconfigured, process-tree-stop-unverified) · grant blocked (recovery-not-enabled, resume-grant-not-implemented, resume-contract-unverified, writer-role-not-approved, thread-unavailable, session-evidence-not-observed, command-evidence-unknown, process-tree-stop-unverified)');
});

for (const [automatic, grant, expected] of [
  [true, false, 'Continuation: automatic allowed () · grant blocked ()'],
  [false, true, 'Continuation: automatic blocked () · grant allowed ()'],
  [true, true, 'Continuation: automatic allowed () · grant allowed ()'],
  [false, false, 'Continuation: automatic blocked () · grant blocked ()'],
]) {
  test(`renders stored allowed flags independently: automatic=${automatic}, grant=${grant}`, () => {
    const meta = storedMeta();
    meta.continuation_eligibility = {
      automatic: { allowed: automatic, blocking_reasons: [] },
      grant: { allowed: grant, blocking_reasons: [] },
    };
    assert.equal(stopRows(meta)[1], expected);
  });
}

test('an absent or null situation keeps older records free of stop rows', () => {
  assert.deepEqual(stopRows({}), []);
  assert.deepEqual(stopRows({ situation: null }), []);
});

test('a present situation requires its stored assessments instead of supplying silent defaults', () => {
  assert.throws(() => stopRows({ situation: storedMeta().situation }), TypeError);
});

test('an archived FAIL reply without assessments stays byte-for-byte unchanged', () => {
  const dir = makeRun();
  const rows = failReply({ runDir: dir, agent: 'codex-build', resultPath: path.join(dir, 'result.json') }, {
    reason: 'result is empty, exit=1', events_bytes: 0, stderr_bytes: 0, result_ok: false, exit: 1,
  });
  assert.equal(rows.join('\n'), [
    'FAIL — result is empty, exit=1',
    'Artifacts: events.jsonl 0 B · stderr.log 0 B · result.json empty or missing · exit=1',
    'Worktree: no new changes',
    `Log: codex-bridge read ${dir}`,
  ].join('\n'));
});

test('a usable-result FAIL does not access or render stop assessments', () => {
  const dir = makeRun();
  const meta = {
    reason: 'verification failed', events_bytes: 0, stderr_bytes: 0, result_ok: true, exit: 1,
    get situation() { throw new Error('usable-result FAIL must not read assessments'); },
  };
  assert.deepEqual(failReply({ runDir: dir, agent: 'codex-advisor', resultPath: path.join(dir, 'result.json') }, meta), [
    'FAIL — verification failed',
    'Artifacts: events.jsonl 0 B · stderr.log 0 B · result.json filled · exit=1',
    `Log: codex-bridge read ${dir}`,
  ]);
});

for (const agent of ['codex-build', 'codex-advisor']) {
  test(`${agent} unusable-result FAIL places diagnostic rows after artifacts/worktree and before log`, () => {
    const dir = makeRun({ args: ['exec', '--json'], events: [], stderr: 'panic: failed before result\n' });
    const { meta, reply } = collect(dir, agent, 1);
    assert.equal(meta.status, 'FAIL');
    assert.equal(meta.result_ok, false);
    const continuation = agent === 'codex-build'
      ? 'Continuation: automatic blocked (recovery-not-enabled, resume-contract-unverified, writer-role-not-approved, thread-unavailable, session-evidence-not-observed, command-evidence-unknown, threshold-unconfigured, process-tree-stop-unverified) · grant blocked (recovery-not-enabled, resume-grant-not-implemented, resume-contract-unverified, writer-role-not-approved, thread-unavailable, session-evidence-not-observed, command-evidence-unknown, process-tree-stop-unverified)'
      : 'Continuation: automatic blocked (recovery-not-enabled, resume-contract-unverified, thread-unavailable, session-evidence-not-observed, command-evidence-unknown, threshold-unconfigured, process-tree-stop-unverified) · grant blocked (recovery-not-enabled, resume-grant-not-implemented, resume-contract-unverified, thread-unavailable, session-evidence-not-observed, command-evidence-unknown, process-tree-stop-unverified)';
    assert.equal(reply, [
      'FAIL — panic: failed before result',
      'Artifacts: events.jsonl 0 B · stderr.log 28 B · result.json empty or missing · exit=1',
      ...(agent === 'codex-build' ? ['Worktree: no new changes'] : []),
      'Situation: evidence-unknown · silence=unknown · threshold=unconfigured · command=unknown',
      continuation,
      'Treatment: inspect-evidence · diagnostic only, nothing runs it',
      `Log: codex-bridge read ${dir}`,
    ].join('\n'));
  });
}
