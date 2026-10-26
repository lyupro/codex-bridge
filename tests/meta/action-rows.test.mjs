/** OW-075 A2: dispatchers must see exactly one registry-owned next step as the third row. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { orderDiagnosticMessage } from '../../src/home/lib/order-diagnostics.mjs';
import { collect } from '../../src/home/lib/write-meta.mjs';
import { failReply, limitReply, unavailableReply } from '../../src/home/lib/meta/reply.mjs';
import { unavailableRows } from '../../src/home/lib/meta/unavailable-rows.mjs';
import { buildResult, COMPLETED_COMMAND, makeRun } from './test-fixtures.mjs';

function assertAction(rows, variant) {
  const expected = orderDiagnosticMessage('next-action', { variant });
  assert.deepEqual(rows.filter((row) => row.startsWith('Action:')), [expected]);
  assert.equal(rows[2], expected);
}

for (const agent of ['codex-build', 'codex-scout', 'codex-review', 'codex-advisor']) {
  for (const [variant, render, result_ok] of [
    ['limit', limitReply, false],
    ['unavailable', unavailableReply, false],
    ['fail-result', failReply, true],
    ['fail-no-result', failReply, false],
  ]) {
    test(`${agent} ${variant} has exactly one registry Action as its third row`, () => {
      const dir = makeRun();
      const rows = render({ agent, runDir: dir, resultPath: path.join(dir, 'result.json') }, {
        reason: 'post-run non-OK', events_bytes: 0, stderr_bytes: 0, exit: 1, result_ok,
      });
      assertAction(rows, variant);
      assert.match(rows[1], variant.startsWith('fail-') ? /^Artifacts: / : /^Signal: /);
      assert.equal(rows.some((row) => row.startsWith('Worktree: ')), agent === 'codex-build');
      assert.equal(rows.at(-1), `Log: codex-bridge read ${dir}`);
    });
  }
}

test('shared UNAVAILABLE rows place exactly one registry Action between signal and operator check', () => {
  const rows = unavailableRows('Not logged in');
  assertAction(rows, 'unavailable');
  assert.equal(rows[1], 'Signal: Not logged in');
  assert.equal(rows[3], 'Operator check: codex --version; codex login status (sign in with codex login)');
  assert.equal(rows.length, 4);
});

for (const result_ok of [undefined, null, 0, '', 1, 'filled']) {
  test(`FAIL chooses its Action by result_ok truthiness (${JSON.stringify(result_ok)})`, () => {
    const dir = makeRun();
    const meta = { reason: 'legacy or non-boolean result', events_bytes: 0, stderr_bytes: 0, exit: 1 };
    if (result_ok !== undefined) meta.result_ok = result_ok;
    const rows = failReply({ agent: 'codex-build', runDir: dir, resultPath: path.join(dir, 'result.json') }, meta);
    assertAction(rows, result_ok ? 'fail-result' : 'fail-no-result');
    assert.equal(rows[3], 'Worktree: no new changes');
    assert.equal(rows.at(-1), `Log: codex-bridge read ${dir}`);
    assert.equal(rows.length, 5);
  });
}

for (const [status, variant, options] of [
  ['LIMIT', 'limit', { events: [{ type: 'error', message: 'quota exhausted' }] }],
  ['UNAVAILABLE', 'unavailable', { events: [{ type: 'turn.failed', error: { message:
    'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header' } }] }],
  ['FAIL', 'fail-result', {
    events: [{ type: 'thread.started', thread_id: 'action-result' }, COMPLETED_COMMAND],
    result: buildResult([], { verify_passed: false }),
  }],
  ['FAIL', 'fail-no-result', { events: [], stderr: 'panic: failed before result\n' }],
]) {
  test(`collected ${status} (${variant}) preserves exactly one third-row registry Action`, () => {
    const dir = makeRun({ args: ['exec', '--json'], ...options });
    const { meta, reply } = collect(dir, 'codex-build', 1);
    assert.equal(meta.status, status);
    assertAction(reply.split('\n'), variant);
  });
}
