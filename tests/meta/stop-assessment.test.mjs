import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { assessStop } from '../../src/home/lib/meta/stop-assessment.mjs';

const stopFacts = () => ({
  trigger: 'deadline',
  stopped_at: '2026-10-15T08:20:00.000Z',
  result_file: { state: 'missing' },
  session: {
    state: 'observed',
    at_reference: {
      last_record_at: '2026-10-15T08:00:00.000Z',
      commands: { state: 'none', reason: null, pending: [] },
    },
  },
});

const input = (overrides = {}) => ({
  status: 'FAIL', resultOk: false, turnFailed: false, outputLimit: false, agentWrites: false, threadId: 'thread',
  stop: stopFacts(), silencePolicy: { threshold_ms: 1200000 }, ...overrides,
});

function changedStop(change) {
  const stop = stopFacts();
  change(stop);
  return stop;
}

// Plan_80 A5/E12: precedence is part of the contract, especially at the threshold.
const cases = [
  ['result wins over LIMIT and absent stop', { resultOk: true, status: 'LIMIT', stop: null }, 'result-present', 'retain-stop-facts'],
  ['result wins over UNAVAILABLE', { resultOk: true, status: 'UNAVAILABLE' }, 'result-present', 'retain-stop-facts'],
  ['LIMIT wins over absent stop', { status: 'LIMIT', stop: null }, 'limit', 'retain-stop-facts'],
  ['UNAVAILABLE wins over absent stop', { status: 'UNAVAILABLE', stop: null }, 'unavailable', 'retain-stop-facts'],
  ...['LIMIT', 'UNAVAILABLE', 'CAPACITY'].map((status) => [
    `${status} wins over output limit`, { status, outputLimit: true }, status.toLowerCase(), 'retain-stop-facts',
  ]),
  ['result wins over output limit', { resultOk: true, outputLimit: true, turnFailed: true }, 'result-present', 'retain-stop-facts'],
  ['older run without stop', { stop: undefined }, 'evidence-unknown', 'inspect-evidence'],
  ['spawn error wins over in-flight commands', { stop: changedStop((s) => {
    s.trigger = 'spawn-error'; s.session.at_reference.commands.state = 'in-flight';
  }) }, 'runner-error', 'inspect-runner-error'],
  ['stream error', { stop: changedStop((s) => { s.trigger = 'stream-error'; }) }, 'runner-error', 'inspect-runner-error'],
  ...['spawn-error', 'stream-error'].map((trigger) => [
    `${trigger} wins over output limit`, { outputLimit: true, stop: changedStop((s) => { s.trigger = trigger; }) },
    'runner-error', 'inspect-runner-error',
  ]),
  ['output limit wins over exit and in-flight commands', { outputLimit: true, turnFailed: true, stop: changedStop((s) => {
    s.trigger = 'exit'; s.session.at_reference.commands.state = 'in-flight';
  }) }, 'output-limit', 'narrow-order-or-lower-effort'],
  ['output limit wins over deadline stall', { outputLimit: true }, 'output-limit', 'narrow-order-or-lower-effort'],
  ['non-FAIL cannot be output limit', { status: 'OK', outputLimit: true, stop: changedStop((s) => {
    s.trigger = 'exit';
  }) }, 'process-exit-no-result', 'inspect-exit-and-drain'],
  ['exit zero without result wins over in-flight commands', { stop: changedStop((s) => {
    s.trigger = 'exit'; s.exit_code = 0; s.session.at_reference.commands.state = 'in-flight';
  }) }, 'process-exit-no-result', 'inspect-exit-and-drain'],
  ['exit nonzero without result', { stop: changedStop((s) => {
    s.trigger = 'exit'; s.exit_code = 1;
  }) }, 'process-exit-no-result', 'inspect-exit-and-drain'],
  ['deadline with in-flight command wins over null threshold', {
    stop: changedStop((s) => { s.session.at_reference.commands.state = 'in-flight'; }),
    silencePolicy: { threshold_ms: null },
  }, 'command-in-flight', 'inspect-command-effects'],
  ['deadline with unknown commands despite old activity', { stop: changedStop((s) => {
    s.session.at_reference.commands = { state: 'unknown', reason: 'orphan tool output', pending: [] };
  }) }, 'evidence-unknown', 'inspect-evidence'],
  ['deadline with absent command evidence', { stop: changedStop((s) => {
    delete s.session.at_reference.commands;
  }) }, 'evidence-unknown', 'inspect-evidence'],
  ['deadline without session timestamp wins over null threshold', {
    stop: changedStop((s) => { s.session.at_reference.last_record_at = null; }),
    silencePolicy: null,
  }, 'evidence-unknown', 'inspect-evidence'],
  ['invalid stop reference', { stop: changedStop((s) => {
    s.stopped_at = null;
  }) }, 'evidence-unknown', 'inspect-evidence'],
  ['deadline with null threshold', { silencePolicy: { threshold_ms: null } }, 'silence-unclassified', 'calibrate-silence-threshold'],
  ['deadline with missing policy', { silencePolicy: null }, 'silence-unclassified', 'calibrate-silence-threshold'],
  ['silence equals threshold', {}, 'silent-stall-candidate', 'retain-stop-facts'],
  ['silence exceeds threshold', { silencePolicy: { threshold_ms: 1199999 } }, 'silent-stall-candidate', 'retain-stop-facts'],
  ['silence one millisecond below threshold', {
    stop: changedStop((s) => { s.session.at_reference.last_record_at = '2026-10-15T08:00:00.001Z'; }),
  }, 'recent-activity', 'retain-stop-facts'],
  ['zero silence is recent', { stop: changedStop((s) => {
    s.session.at_reference.last_record_at = s.stopped_at;
  }) }, 'recent-activity', 'retain-stop-facts'],
  ['negative age is unknown', { stop: changedStop((s) => {
    s.session.at_reference.last_record_at = '2026-10-15T08:20:00.001Z';
  }) }, 'evidence-unknown', 'inspect-evidence'],
  ['null trigger never classifies silence', { stop: changedStop((s) => {
    s.trigger = null;
  }) }, 'evidence-unknown', 'inspect-evidence'],
];

for (const [name, overrides, kind, action] of cases) {
  test(name, () => {
    const args = input(overrides);
    const before = structuredClone(args);
    const result = assessStop(args);
    assert.equal(result.situation.kind, kind);
    assert.deepEqual(result.treatment, { version: 1, effect: 'diagnostic-only', action });
    assert.equal(result.continuation_eligibility.version, 3);
    assert.equal(result.continuation_eligibility.automatic.allowed, false);
    assert.equal(result.continuation_eligibility.grant.allowed, false);
    assert.deepEqual(args, before, 'assessment must not mutate frozen facts');
    assert.deepEqual(assessStop(args), result);
  });
}

// Plan_80 E28: a retired silence trigger cannot establish a deadline stall.
test('silence trigger is unknown evidence with automatic and grant eligibility denied', () => {
  const stop = changedStop((s) => { s.trigger = 'silence'; });
  const result = assessStop(input({ stop }));
  assert.equal(result.situation.kind, 'evidence-unknown');
  assert.equal(result.situation.cause, 'silence');
  assert.deepEqual(result.treatment, { version: 1, effect: 'diagnostic-only', action: 'inspect-evidence' });
  assert.deepEqual(result.continuation_eligibility.automatic, {
    allowed: false, blocking_reasons: ['recovery-policy-missing', 'process-tree-stop-unverified'],
  });
  assert.deepEqual(result.continuation_eligibility.grant, {
    allowed: false, policy_version: 2, blocking_reasons: ['process-tree-stop-unverified'],
  });
});

const enabledPolicy = { enabled: true, brake: { value: 'on' }, budget_ms: 1102000 };
const cleanInput = (overrides = {}) => input({
  stop: changedStop((s) => { s.tree_stop = { state: 'stopped' }; }),
  silencePolicy: { threshold_ms: 996000 }, recoveryPolicy: enabledPolicy, resumedFrom: null, ...overrides,
});

test('only silent-stall-candidate can be automatically eligible with a clean enabled policy', () => {
  const kinds = new Set();
  for (const [, overrides, kind] of cases) {
    if (kind === 'silent-stall-candidate') continue;
    const args = cleanInput({ silencePolicy: { threshold_ms: 1200000 }, ...overrides });
    if (args.stop) args.stop.tree_stop = { state: 'stopped' };
    const result = assessStop(args);
    assert.equal(result.situation.kind, kind);
    assert.equal(result.continuation_eligibility.automatic.allowed, false, kind);
    // A refusal always names its reason: the reply must never print "blocked ()".
    assert.ok(result.continuation_eligibility.automatic.blocking_reasons.length > 0, kind);
    kinds.add(kind);
  }
  assert.deepEqual([...kinds].sort(), ['result-present', 'limit', 'unavailable', 'capacity', 'runner-error', 'output-limit',
    'process-exit-no-result', 'command-in-flight', 'evidence-unknown', 'silence-unclassified',
    'recent-activity'].sort());
  const result = assessStop(cleanInput());
  assert.equal(result.situation.kind, 'silent-stall-candidate');
  assert.equal(result.situation.cause, 'deadline');
  assert.equal(result.situation.silence_ms, 1200000);
  assert.equal(result.situation.threshold_ms, 996000);
  assert.deepEqual(result.continuation_eligibility.automatic, { allowed: true, blocking_reasons: [] });
});

test('an undiagnosed stop with otherwise clean facts is refused as stall-not-established', () => {
  const args = cleanInput();
  args.stop.session.at_reference.last_record_at = null;
  const result = assessStop(args);
  assert.equal(result.situation.kind, 'evidence-unknown');
  assert.deepEqual(result.continuation_eligibility.automatic,
    { allowed: false, blocking_reasons: ['stall-not-established'] });
});

for (const [overrides, reason] of [
  ...[null, undefined, false, 1, 'policy'].map((recoveryPolicy) => [
    { recoveryPolicy }, 'recovery-policy-missing',
  ]),
  ...[false, undefined, 1, 'true'].map((enabled) => [
    { recoveryPolicy: { ...enabledPolicy, enabled } }, 'recovery-not-enabled',
  ]),
  [{ recoveryPolicy: { ...enabledPolicy, brake: { value: 'off' } } }, 'recovery-brake-off'],
  ...[null, undefined, 0, -1, 1.5, NaN, Infinity, '1102000'].map((budget_ms) => [
    { recoveryPolicy: { ...enabledPolicy, budget_ms } }, 'recovery-budget-unconfigured',
  ]),
  [{ resumedFrom: 'prior-run' }, 'recovery-attempt-spent'],
]) {
  test(`automatic policy blocker appears alone: ${reason}, ${JSON.stringify(overrides)}`, () => {
    const args = cleanInput(overrides);
    const before = structuredClone(args);
    assert.deepEqual(assessStop(args).continuation_eligibility.automatic, {
      allowed: false, blocking_reasons: [reason],
    });
    assert.deepEqual(args, before);
  });
}

test('policy and spent-attempt blockers precede factual blockers in the fixed E15 order', () => {
  assert.deepEqual(assessStop(cleanInput({
    recoveryPolicy: { enabled: false, brake: { value: 'off' }, budget_ms: 0 },
    resumedFrom: 'prior-run', status: 'LIMIT', agentWrites: true, threadId: null, silencePolicy: null,
  })).continuation_eligibility.automatic.blocking_reasons, [
    'recovery-not-enabled', 'recovery-brake-off', 'recovery-budget-unconfigured', 'recovery-attempt-spent',
    'limit', 'writer-role-not-approved', 'thread-unavailable', 'threshold-unconfigured', 'not-silent-stall',
  ]);
  for (const resumedFrom of [null, undefined, '', 42, {}]) {
    assert.deepEqual(assessStop(cleanInput({ resumedFrom })).continuation_eligibility.automatic,
      { allowed: true, blocking_reasons: [] });
  }
  assert.deepEqual(assessStop(cleanInput({ recoveryPolicy: null, resumedFrom: 'prior-run' }))
    .continuation_eligibility.automatic.blocking_reasons, ['recovery-policy-missing', 'recovery-attempt-spent']);
});

test('situation records only frozen facts and a pending count, never command identities', () => {
  const stop = changedStop((s) => {
    s.session.at_reference.commands = { state: 'in-flight', reason: null, pending: [
      { call_id: 'private-1', name: 'exec' }, { call_id: 'private-2', name: 'exec' },
    ] };
  });
  assert.deepEqual(assessStop(input({ stop })).situation, {
    version: 1, kind: 'command-in-flight', cause: 'deadline',
    silence_ms: 1200000, silence_reason: null, threshold_ms: 1200000,
    commands: { state: 'in-flight', reason: null, pending_count: 2 },
    session_state: 'observed', result_file_state: 'missing',
  });
});

test('older facts stay null and silence explains the absent reference', () => {
  assert.deepEqual(assessStop(input({ stop: null, silencePolicy: null })).situation, {
    version: 1, kind: 'evidence-unknown', cause: null,
    silence_ms: null, silence_reason: 'reference time invalid', threshold_ms: null,
    commands: { state: null, reason: null, pending_count: null },
    session_state: null, result_file_state: null,
  });
});

test('stalled advise has the exact ordered diagnostic-only blockers', () => {
  assert.deepEqual(assessStop(input()).continuation_eligibility, {
    version: 3,
    automatic: { allowed: false, blocking_reasons: [
      'recovery-policy-missing', 'process-tree-stop-unverified',
    ] },
    grant: { allowed: false, policy_version: 2, blocking_reasons: [
      'process-tree-stop-unverified',
    ] },
  });
});

test('build records writer-role and unconfigured-threshold blockers in order', () => {
  assert.deepEqual(assessStop(input({ agentWrites: true, silencePolicy: { threshold_ms: null } }))
    .continuation_eligibility, {
    version: 3,
    automatic: { allowed: false, blocking_reasons: [
      'recovery-policy-missing', 'writer-role-not-approved',
      'threshold-unconfigured', 'process-tree-stop-unverified',
    ] },
    grant: { allowed: false, policy_version: 2, blocking_reasons: [
      'writer-role-not-approved', 'process-tree-stop-unverified',
    ] },
  });
});

test('missing session log is unknown evidence with exact blockers, never a silent stall', () => {
  const stop = changedStop((s) => {
    s.session = { state: 'missing', at_reference: {
      last_record_at: null,
      commands: { state: 'unknown', reason: 'session missing', pending: [] },
    } };
  });
  const result = assessStop(input({ stop }));
  assert.equal(result.situation.kind, 'evidence-unknown');
  assert.equal(result.situation.silence_ms, null);
  assert.equal(result.situation.silence_reason, 'session evidence missing');
  assert.deepEqual(result.continuation_eligibility, {
    version: 3,
    automatic: { allowed: false, blocking_reasons: [
      'recovery-policy-missing', 'session-evidence-missing',
      'command-evidence-unknown', 'process-tree-stop-unverified',
    ] },
    grant: { allowed: false, policy_version: 2, blocking_reasons: [
      'session-evidence-missing', 'process-tree-stop-unverified',
    ] },
  });
});

test('LIMIT without a result has the exact ordered blockers', () => {
  assert.deepEqual(assessStop(input({ status: 'LIMIT' })).continuation_eligibility, {
    version: 3,
    automatic: { allowed: false, blocking_reasons: [
      'recovery-policy-missing', 'limit',
      'not-silent-stall', 'process-tree-stop-unverified',
    ] },
    grant: { allowed: false, policy_version: 2, blocking_reasons: [
      'limit', 'process-tree-stop-unverified',
    ] },
  });
});

test('all applicable factual blockers survive result and LIMIT precedence', () => {
  const stop = changedStop((s) => {
    s.session.at_reference.commands.state = 'in-flight';
  });
  assert.deepEqual(assessStop(input({
    status: 'LIMIT', resultOk: true, agentWrites: true, threadId: null,
    stop, silencePolicy: null,
  })).continuation_eligibility, {
    version: 3,
    automatic: { allowed: false, blocking_reasons: [
      'recovery-policy-missing', 'result-present', 'limit',
      'writer-role-not-approved', 'thread-unavailable', 'command-in-flight',
      'threshold-unconfigured', 'not-silent-stall', 'process-tree-stop-unverified',
    ] },
    grant: { allowed: false, policy_version: 2, blocking_reasons: [
      'result-present', 'limit', 'writer-role-not-approved', 'thread-unavailable',
      'process-tree-stop-unverified',
    ] },
  });
});

test('UNAVAILABLE with no session or commands reports absence, not silence', () => {
  assert.deepEqual(assessStop(input({
    status: 'UNAVAILABLE', threadId: null, stop: null, silencePolicy: null,
  })).continuation_eligibility, {
    version: 3,
    automatic: { allowed: false, blocking_reasons: [
      'recovery-policy-missing', 'unavailable', 'thread-unavailable',
      'session-evidence-not-observed', 'command-evidence-unknown', 'threshold-unconfigured',
      'not-silent-stall', 'process-tree-stop-unverified',
    ] },
    grant: { allowed: false, policy_version: 2, blocking_reasons: [
      'unavailable', 'stop-record-missing', 'thread-unavailable', 'session-evidence-not-observed', 'process-tree-stop-unverified',
    ] },
  });
});

for (const state of ['not-observed', 'unreadable', 'empty', 'unrecognized', 'incomplete']) {
  test(`session state ${state} remains a factual blocker`, () => {
    const stop = changedStop((s) => {
      s.session.state = state;
      s.session.at_reference.commands = { state: 'unknown', reason: `session ${state}`, pending: [] };
    });
    const result = assessStop(input({ stop }));
    assert.equal(result.situation.silence_ms, null);
    assert.equal(result.situation.silence_reason, `session evidence ${state}`);
    for (const path of ['automatic', 'grant']) {
      assert.equal(result.continuation_eligibility[path].allowed, false);
      assert.ok(result.continuation_eligibility[path].blocking_reasons.includes(`session-evidence-${state}`));
    }
  });
}

test('receipt independence across every kind and arbitrary receipt summaries', () => {
  for (const [, overrides] of cases) {
    const args = input(overrides);
    if (!args.stop) continue;
    const expected = assessStop(args);
    for (const receipts of [null, {}, { lines: 999, last_received_at: '2099-01-01T00:00:00.000Z' },
      { lines: 0, write_error: 'disk full', truncated: true, incomplete: true }]) {
      assert.deepEqual(assessStop({ ...args, stop: { ...args.stop, receipts } }), expected);
    }
  }
});

function guardSource(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, '');
  const permitted = /\bimport\s*\{\s*silenceAgeMs\s*\}\s*from\s*(['"])\.\.\/codex-session-log\.mjs\1\s*;/g;
  assert.equal([...code.matchAll(permitted)].length, 1, 'only the silenceAgeMs import is permitted');
  assert.doesNotMatch(code.replace(permitted, ''), /\bimport\b/, 'no other imports are permitted');
  assert.doesNotMatch(code, /\b(?:receipts|events|heartbeat)\b|node:fs/, 'frozen session facts only');
}

test('static guard allows only silenceAgeMs and no alternate activity sources', () => {
  const source = fs.readFileSync(new URL('../../src/home/lib/meta/stop-assessment.mjs', import.meta.url), 'utf8');
  guardSource(source);
  assert.throws(() => guardSource(`${source}\nstop.receipts;`), /frozen session facts only/);
  for (const mutation of ["import fs from 'node:fs';", "import 'another-module';",
    "import('another-module');", 'stop.events;', 'stop.heartbeat;']) {
    assert.throws(() => guardSource(`${source}\n${mutation}`));
  }
  assert.throws(() => guardSource(source.replace('{ silenceAgeMs }', '{ silenceAgeMs, readSessionActivity }')));
});
