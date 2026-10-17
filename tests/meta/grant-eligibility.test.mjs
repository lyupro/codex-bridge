import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessStop, grantBlockers, GRANT_POLICY_VERSION } from '../../src/home/lib/meta/stop-assessment.mjs';

const input = () => ({
  status: 'FAIL', resultOk: false, agentWrites: false, threadId: 'thread',
  silencePolicy: { threshold_ms: 1200000 },
  stop: {
    version: 2, trigger: 'deadline', stopped_at: '2026-10-15T08:20:00.000Z',
    tree_stop: { state: 'stopped' },
    session: {
      state: 'observed',
      at_reference: {
        last_record_at: '2026-10-15T08:00:00.000Z',
        commands: { state: 'none', reason: null, pending: [] },
      },
    },
  },
});

test('policy version 1 allows an otherwise eligible silent stall without mutating facts', () => {
  const args = input();
  const before = structuredClone(args);
  assert.equal(GRANT_POLICY_VERSION, 1);
  assert.equal(assessStop(args).situation.kind, 'silent-stall-candidate');
  assert.deepEqual(grantBlockers(args), []);
  assert.deepEqual(grantBlockers(args), []);
  assert.deepEqual(args, before);
  assert.deepEqual(assessStop(args).continuation_eligibility, {
    version: 3,
    automatic: { allowed: false, blocking_reasons: ['recovery-policy-missing'] },
    grant: { allowed: true, policy_version: 1, blocking_reasons: [] },
  });
});

const cases = [
  ['usable result', (args) => { args.resultOk = true; }, ['result-present']],
  ['LIMIT status', (args) => { args.status = 'LIMIT'; }, ['limit']],
  ['UNAVAILABLE status', (args) => { args.status = 'UNAVAILABLE'; }, ['unavailable']],
  ...['spawn-error', 'stream-error'].map((trigger) => [
    trigger, (args) => { args.stop.trigger = trigger; }, ['runner-error'],
  ]),
  ['writer role', (args) => { args.agentWrites = true; }, ['writer-role-not-approved']],
  ['missing thread', (args) => { args.threadId = null; }, ['thread-unavailable']],
  ...['not-observed', 'missing', 'unreadable', 'empty', 'unrecognized', 'incomplete'].map((state) => [
    `session ${state}`, (args) => { args.stop.session.state = state; }, [`session-evidence-${state}`],
  ]),
  ['absent session', (args) => { delete args.stop.session; }, ['session-evidence-not-observed']],
  ['absent session state', (args) => { delete args.stop.session.state; }, ['session-evidence-not-observed']],
  ['unverified tree stop', (args) => { args.stop.tree_stop.state = 'unverified'; }, ['process-tree-stop-unverified']],
  ['unknown tree stop', (args) => { args.stop.tree_stop.state = 'unknown'; }, ['process-tree-stop-unverified']],
  ['absent tree stop state', (args) => { delete args.stop.tree_stop.state; }, ['process-tree-stop-unverified']],
  ['version-1 stop without tree_stop', (args) => {
    args.stop.version = 1;
    delete args.stop.tree_stop;
  }, ['process-tree-stop-unverified']],
];

for (const [name, change, expected] of cases) {
  test(`grant blocker: ${name}`, () => {
    const args = input();
    change(args);
    const before = structuredClone(args);
    assert.deepEqual(grantBlockers(args), expected);
    assert.deepEqual(assessStop(args).continuation_eligibility.grant, {
      allowed: false, policy_version: 1,
      blocking_reasons: expected,
    });
    assert.deepEqual(args, before);
  });
}

for (const stop of [null, undefined]) {
  test(`missing stop (${stop}) records every unavailable safety fact`, () => {
    assert.deepEqual(grantBlockers({ ...input(), stop }), [
      'stop-record-missing', 'session-evidence-not-observed', 'process-tree-stop-unverified',
    ]);
  });
}

// Plan_80 E13/Q2: command effects are structurally denied for read-only roles;
// only the automatic path retains command and stall-classification blockers.
for (const [state, blocker, kind] of [
  ['in-flight', 'command-in-flight', 'command-in-flight'],
  ['unknown', 'command-evidence-unknown', 'evidence-unknown'],
  [null, 'command-evidence-unknown', 'evidence-unknown'],
]) {
  test(`command evidence ${state} does not block a grant and stays visible`, () => {
    const args = input();
    args.stop.session.at_reference.commands.state = state;
    const assessment = assessStop(args);
    assert.equal(assessment.situation.kind, kind);
    assert.equal(assessment.situation.commands.state, state);
    assert.deepEqual(grantBlockers(args), []);
    assert.deepEqual(assessment.continuation_eligibility.automatic.blocking_reasons, [
      'recovery-policy-missing', blocker,
      ...(state === 'in-flight' ? ['not-silent-stall'] : []),
    ]);
    assert.deepEqual(assessment.continuation_eligibility.grant.blocking_reasons, []);
  });
}

test('absent command evidence does not block a grant', () => {
  const args = input();
  delete args.stop.session.at_reference.commands;
  assert.deepEqual(grantBlockers(args), []);
});

test('process-exit-no-result with an observed exited tree is grant eligible', () => {
  const args = input();
  args.stop.trigger = 'exit';
  args.stop.tree_stop.state = 'exited';
  assert.equal(assessStop(args).situation.kind, 'process-exit-no-result');
  assert.deepEqual(grantBlockers(args), []);
  assert.deepEqual(assessStop(args).continuation_eligibility.automatic.blocking_reasons, [
    'recovery-policy-missing', 'not-silent-stall',
  ]);
});

for (const [name, change, kind] of [
  ['unconfigured threshold', (args) => { args.silencePolicy = null; }, 'silence-unclassified'],
  ['recent activity', (args) => {
    args.stop.session.at_reference.last_record_at = args.stop.stopped_at;
  }, 'recent-activity'],
  ['unknown cause', (args) => { args.stop.trigger = null; }, 'evidence-unknown'],
]) {
  test(`${name} is diagnostic, not a grant blocker`, () => {
    const args = input();
    change(args);
    assert.equal(assessStop(args).situation.kind, kind);
    assert.deepEqual(grantBlockers(args), []);
  });
}

test('all applicable blockers have a fixed order even when result precedence hides the runner error', () => {
  for (const status of ['LIMIT', 'UNAVAILABLE']) {
    const args = input();
    Object.assign(args, { resultOk: true, status, agentWrites: true, threadId: null });
    args.stop.trigger = 'stream-error';
    args.stop.session.state = 'unreadable';
    args.stop.tree_stop.state = 'unverified';
    const expected = [
      'result-present', status.toLowerCase(), 'runner-error', 'writer-role-not-approved',
      'thread-unavailable', 'session-evidence-unreadable', 'process-tree-stop-unverified',
    ];
    assert.deepEqual(grantBlockers(args), expected);
    assert.deepEqual(assessStop(args).continuation_eligibility.grant.blocking_reasons,
      expected);
    // A missing stop cannot also carry a runner-error trigger; check that ordering separately.
    args.stop = null;
    assert.deepEqual(grantBlockers(args), [
      'result-present', status.toLowerCase(), 'writer-role-not-approved', 'stop-record-missing',
      'thread-unavailable', 'session-evidence-not-observed', 'process-tree-stop-unverified',
    ]);
  }
});
