import test from 'node:test';
import assert from 'node:assert/strict';
import { exitCodeFor } from '../../src/home/lib/write-meta.mjs';
import { limitReply, unavailableReply, unavailableRows } from '../../src/home/lib/meta/reply.mjs';
import { parseReply } from '../../src/home/hooks/reply-parser.mjs';

test('Plan_60 D2: status exit codes distinguish executor handoff from quota limits', () => {
  for (const [status, expected] of [
    ['OK', 0],
    ['FAIL', 1],
    ['LIMIT', 3],
    ['UNAVAILABLE', 5],
    ['unknown', 1],
  ]) {
    assert.equal(exitCodeFor(status), expected, status);
  }
});

test('UNAVAILABLE rows give the shared refusal signal and operator check', () => {
  const rows = unavailableRows('codex login status: Not logged in');
  assert.ok(rows[0].startsWith('UNAVAILABLE — '));
  assert.deepEqual(rows, [
    'UNAVAILABLE — Codex is not available (signed out); ' +
      'hand the task to the next executor, do not retry',
    'Signal: codex login status: Not logged in',
    'Operator check: codex --version; codex login status (sign in with codex login)',
  ]);
});

test('pre-start UNAVAILABLE refusal claims its status without a run folder', () => {
  const reply = unavailableRows('codex login status: Not logged in').join('\n');
  assert.deepEqual(parseReply(reply), { claimed: 'UNAVAILABLE', runDirs: [] });
});

test('UNAVAILABLE mentioned inside a sentence does not claim a status', () => {
  assert.deepEqual(parseReply('The executor returned UNAVAILABLE — sign in first'), {
    claimed: undefined,
    runDirs: [],
  });
});

test('LIMIT continues to claim its existing status', () => {
  assert.deepEqual(parseReply('LIMIT — ChatGPT quota exhausted, work not completed'), {
    claimed: 'LIMIT',
    runDirs: [],
  });
});

test('post-start UNAVAILABLE appends the log and mirrors LIMIT worktree rows for builds only', () => {
  const meta = { reason: 'Codex missing' };
  for (const agent of ['codex-build', 'codex-scout', 'codex-review', 'codex-advisor']) {
    const ctx = { agent, runDir: 'tests/meta' };
    const suffix = limitReply(ctx, meta).slice(2);
    assert.deepEqual(unavailableReply(ctx, meta), [...unavailableRows(meta.reason), ...suffix]);
    assert.equal(suffix.some((row) => row.startsWith('Worktree: ')), agent === 'codex-build');
    assert.equal(suffix.at(-1), 'Log: codex-bridge read tests/meta');
  }
});
