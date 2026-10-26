/** OW-075: next-step rows have one registry owner and CAPACITY keeps its public bytes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderDiagnosticMessage } from '../../src/home/lib/order-diagnostics.mjs';
import { capacityReply } from '../../src/home/lib/meta/reply.mjs';

const variants = [
  ['pending', 'the run is still working and nothing new was started; repeat the same call without --no-wait to wait for its verdict; never start the order again under another id'],
  ['pending-no-run', 'no run exists for this order and --no-wait never starts one; call again without --no-wait to start it'],
  ['capacity', "wait or change this role's model (/codex-bridge:model), then repeat the same order once with a retry: grant; never resume: this run; a second CAPACITY for the same order goes to the next executor"],
  ['limit', 'the ChatGPT quota window is spent; do not retry or resume through this bridge, hand the order to the next executor; for a build, check the Worktree row first'],
  ['unavailable', 'Codex is signed out on this host; do not retry this bridge, hand the order to the next executor and ask the operator to run codex login'],
  ['fail-result', 'the run returned a result that did not pass; read the report and git status before deciding; a repeat of this pass needs your retry: grant, the next pass your continue: grant'],
  ['fail-no-result', 'the run left no usable result; read the log and git status before deciding; repeat only through a grant this reply offers or the operator approves, never take over the task yourself'],
  ['usage', 'nothing was started and no quota was spent; fix the task file or the call as the refusal says, then call again'],
  ['grant-decision', "nothing was started and no quota was spent; the grant does not fit the run it names: read that run's outcome, then call again with the grant or new order id the refusal names; never change the task to get past it"],
  ['run-in-progress', 'nothing was started and no quota was spent; another run holds this order or writes in this tree: wait for it (repeating the same order attaches to a run of that order), then call again; never stop it without the operator'],
  ['runs-root-retired', 'nothing was started and no quota was spent; the runs root setting points at a retired location: show this to the operator to fix CODEX_RUNS_ROOT, then repeat the same order'],
  ['repository-detached', 'nothing was started and no quota was spent; the repository is not on the branch an abandoned run expects: show this to the operator and repair the branch only with their approval, then repeat the same order'],
  ['sandbox-dead', 'nothing was started and no quota was spent; the Codex sandbox cannot start on this host: show this output to the operator, do not change the order, and hand it to the next executor if it cannot wait'],
  ['advisor-scope-result', 'nothing was started and no quota was spent; the scope run named in continue: has no usable result: repeat that scope with retry: or under a new order id, then call advise again'],
  ['runner-fault', 'the runner failed before the work started; show this output to the operator and hand the order to the next executor; do not repeat it unchanged'],
  ['readiness-unconfirmed', 'check codex --version for up to about 2 minutes; when it answers, repeat the same order exactly once; otherwise, or on the same refusal again, hand the order to the next executor and name that in the summary'],
  ['availability-unconfirmed', 'show this output to the operator (codex --version, and codex login if authorization is rejected); do not treat it as signed out and do not change the order'],
];

for (const [variant, text] of variants) {
  test(`next-action ${variant} renders its exact single non-empty Action row`, () => {
    const row = orderDiagnosticMessage('next-action', { variant });
    assert.equal(row, `Action: ${text}`);
    assert.match(row, /^Action: \S/);
    assert.doesNotMatch(row, /[\r\n]/);
  });
}

test('next-action rejects absent and unknown variants without inherited property fallbacks', () => {
  for (const variant of [undefined, null, '', 'unknown', 'toString', '__proto__']) {
    assert.throws(() => orderDiagnosticMessage('next-action', { variant }), {
      message: `unknown next-action variant: ${variant}`,
    });
  }
  assert.throws(() => orderDiagnosticMessage('next-action'), {
    message: 'unknown next-action variant: undefined',
  });
});

test('capacityReply prints exactly the capacity next-action row', () => {
  const rows = capacityReply({ agent: 'codex-scout', runDir: 'C:/runs/capacity' }, { reason: 'at capacity' });
  assert.deepEqual(rows.filter((row) => row.startsWith('Action: ')), [
    orderDiagnosticMessage('next-action', { variant: 'capacity' }),
  ]);
});
