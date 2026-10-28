/** Plan_80 E17 arbiter A15 pre-mortem 1: automatic recovery cannot bypass a grant blocker. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessStop, grantBlockers } from '../../src/home/lib/meta/stop-assessment.mjs';

function facts({ status, resultOk, turnFailed, agentWrites, threadId, stopPresent, sessionState, treeState }) {
  return {
    status, resultOk, turnFailed, agentWrites, threadId,
    stop: stopPresent ? {
      version: 2, trigger: 'deadline', stopped_at: '2026-10-16T09:30:00.000Z',
      tree_stop: { state: treeState },
      session: {
        state: sessionState, last_record_at: '2026-10-16T09:25:00.000Z',
        at_reference: {
          last_record_at: '2026-10-16T09:25:00.000Z',
          commands: { state: 'none', reason: null, pending: [] },
        },
      },
    } : null,
    silencePolicy: { threshold_ms: 60_000 },
    recoveryPolicy: { enabled: true, budget_ms: 120_000, brake: { value: 'on' } },
    resumedFrom: null,
  };
}

test('Plan_80 E17 A15: every grant-blocked stop also blocks otherwise funded automatic recovery', () => {
  let checked = 0;
  let allowed = 0;
  for (const turnFailed of [false, true]) for (const status of ['FAIL', 'LIMIT', 'UNAVAILABLE'])
    for (const resultOk of [false, true])
      for (const agentWrites of [false, true])
        for (const threadId of ['failed-thread', null])
          for (const stopPresent of [true, false])
            for (const sessionState of ['observed', 'missing'])
              for (const treeState of ['stopped', 'unverified']) {
                const row = { status, resultOk, turnFailed, agentWrites, threadId, stopPresent, sessionState, treeState };
                const input = facts(row);
                const blockers = grantBlockers(input);
                const assessment = assessStop(input);
                assert.equal(blockers.includes('codex-turn-failed'), turnFailed && !resultOk);
                assert.equal(assessment.continuation_eligibility.automatic.blocking_reasons
                  .includes('codex-turn-failed'), turnFailed && !resultOk);
                if (blockers.length) {
                  assert.equal(assessment.continuation_eligibility.automatic.allowed, false,
                    `${JSON.stringify(row)}; grant blockers: ${blockers.join(', ')}`);
                  checked += 1;
                } else {
                  // A passing control catches an accidentally unfunded or uncalibrated fixture.
                  assert.equal(assessment.situation.kind, 'silent-stall-candidate');
                  assert.equal(assessment.continuation_eligibility.automatic.allowed, true);
                  allowed += 1;
                }
              }
  assert.equal(checked, 383);
  assert.equal(allowed, 1);
});
