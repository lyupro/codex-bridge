/** Plan_80 A5: pin collect's public replies before adding diagnostic-only stop rows. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { collect } from '../../src/home/lib/write-meta.mjs';
import { buildResult, COMPLETED_COMMAND, makeRun } from './test-fixtures.mjs';

const events = [{ type: 'thread.started', thread_id: 'reply-snapshot' }, COMPLETED_COMMAND];
const scoutAnswer = 'The reply points the operator at the structured read command so the run can be inspected '
  + 'without guessing artifact paths. The command reads the retained events and diagnostic output, '
  + 'and the same link remains available after a successful scout has explained the requested code.';

function snapshot(agent, options, exit, expectedStatus, expected) {
  const dir = makeRun({ args: ['exec', '--json'], events, ...options });
  if (options.advisorPhase) {
    fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ state: 'running', repo: dir, phase: options.advisorPhase }));
    fs.writeFileSync(path.join(dir, 'advisor-task.json'), JSON.stringify({
      options: [{ id: 'A' }, { id: 'B' }], paths: [],
      ...(options.advisorPhase === 'advise' ? { scope: { predicted_risks: [], missing_paths: [] } } : {}),
    }));
  }
  const { meta, reply } = collect(dir, agent, exit);
  assert.equal(meta.status, expectedStatus);
  // Only the temporary run path varies; preserve every other byte, including artifact sizes.
  const normalized = reply.replaceAll(dir, '<run>').replaceAll(path.join('<run>', 'report.md'), '<run>/report.md')
    .replaceAll(path.join('<run>', 'review.json'), '<run>/review.json')
    .replaceAll(path.join('<run>', 'result.json'), '<run>/result.json');
  assert.equal(normalized, expected);
}

test('OK scout reply snapshot', () => {
  snapshot('codex-scout', { result: { answer: scoutAnswer, findings: [], unknowns: [], report_markdown: '# report' } }, 0, 'OK',
    'OK — The reply points the operator at the structured read command so the run can be inspected without guessing artifact paths. The command reads the retained...\n'
    + 'Key finding: no findings listed\n'
    + 'Unresolved: none\n'
    + 'Report: <run>/report.md · Log: codex-bridge read <run>');
});

test('OK build reply snapshot', () => {
  snapshot('codex-build', { result: buildResult([]) }, 0, 'OK',
    'OK — done\n'
    + 'Files: 0 changed · worktree untouched\n'
    + 'Verification: npm test — pass\n'
    + 'Flags: none\n'
    + 'Report: <run>/report.md · Log: codex-bridge read <run>');
});

test('OK review reply snapshot', () => {
  snapshot('codex-review', { file: 'review.json', result: { verdict: 'approve', findings: [] } }, 0, 'OK',
    'OK — verdict approve\n'
    + 'Findings: critical 0 · high 0 · medium 0 · low 0\n'
    + 'Top: no critical or high findings\n'
    + 'Report: <run>/review.json · Log: codex-bridge read <run>');
});

test('OK advisor scope reply snapshot', () => {
  snapshot('codex-advisor', { advisorPhase: 'scope', result: {
    sufficient: true, missing_paths: [], taken_on_trust: ['The supplied constraints are complete.'], predicted_risks: [],
  } }, 0, 'OK',
    'OK — scope: sufficient; continue this run with `phase:` advise\n'
    + 'Predicted risks: 0\n'
    + 'Report: <run>/result.json · Log: codex-bridge read <run>');
});

test('OK advisor advise reply snapshot', () => {
  snapshot('codex-advisor', { advisorPhase: 'advise', result: {
    recommendation: { option_id: 'A', text: 'Keep the stored evidence authoritative.' },
    rejected: [{ option_id: 'B', cost: 'Recomputing evidence can change its meaning.' }],
    strongest_counterargument: 'Stored evidence may be incomplete.', confidence: 'high',
    risk_outcomes: [], open_questions: [], assumptions: [], pre_mortem: [], unlisted_option: 'none',
  } }, 0, 'OK',
    'OK — recommend A: Keep the stored evidence authoritative.\n'
    + 'Rejected: B (Recomputing evidence can change its meaning.)\n'
    + 'Counter: Stored evidence may be incomplete.\n'
    + 'Risks: 0 confirmed · 0 refuted · open questions 0 · confidence high\n'
    + 'Report: <run>/result.json · Log: codex-bridge read <run>');
});

test('LIMIT reply snapshot', () => {
  snapshot('codex-build', { events: [{ type: 'error', message: 'quota exhausted' }] }, 1, 'LIMIT',
    'LIMIT — ChatGPT quota exhausted, work not completed\n'
    + 'Signal: quota exhausted\n'
    + 'Action: the ChatGPT quota window is spent; do not retry or resume through this bridge, hand the order to the next executor; for a build, check the Worktree row first\n'
    + 'Worktree: no new changes\n'
    + 'Log: codex-bridge read <run>');
});

test('UNAVAILABLE reply snapshot', () => {
  snapshot('codex-build', { events: [{ type: 'turn.failed', error: { message:
    'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header' } }] }, 1, 'UNAVAILABLE',
    'UNAVAILABLE — Codex is not available (signed out); hand the task to the next executor, do not retry\n'
    + 'Signal: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header\n'
    + 'Action: Codex is signed out on this host; do not retry this bridge, hand the order to the next executor and ask the operator to run codex login\n'
    + 'Operator check: codex --version; codex login status (sign in with codex login)\n'
    + 'Worktree: no new changes\n'
    + 'Log: codex-bridge read <run>');
});

test('FAIL with a usable result reply snapshot', () => {
  snapshot('codex-build', { result: buildResult([], { verify_passed: false }) }, 0, 'FAIL',
    'FAIL — verification “npm test” failed; changes remain in the tree\n'
    + 'Artifacts: events.jsonl 252 B · stderr.log 0 B · result.json filled · exit=0\n'
    + 'Action: the run returned a result that did not pass; read the report and git status before deciding; a repeat of this pass needs your retry: grant, the next pass your continue: grant\n'
    + 'Worktree: no new changes\n'
    + 'Log: codex-bridge read <run>');
});

test('FAIL without a result reply snapshot', () => {
  snapshot('codex-build', { stderr: 'panic: failed before result\n' }, 1, 'FAIL',
    'FAIL — panic: failed before result\n'
    + 'Artifacts: events.jsonl 252 B · stderr.log 28 B · result.json empty or missing · exit=1\n'
    + 'Action: the run left no usable result; read the log and git status before deciding; repeat only through a grant this reply offers or the operator approves, never take over the task yourself\n'
    + 'Worktree: no new changes\n'
    + 'Situation: evidence-unknown · silence=unknown · threshold=unconfigured · command=unknown\n'
    + 'Continuation: automatic blocked (recovery-policy-missing, writer-role-not-approved, session-evidence-not-observed, command-evidence-unknown, threshold-unconfigured, process-tree-stop-unverified) · grant blocked (writer-role-not-approved, stop-record-missing, session-evidence-not-observed, process-tree-stop-unverified)\n'
    + 'Treatment: inspect-evidence · diagnostic only, nothing runs it\n'
    + 'Log: codex-bridge read <run>');
});
