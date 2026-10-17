/** Plan_80 E17: delayed publication must render recorded evidence without collecting again. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collect, exitCodeFor, renderReply, writeStatus } from '../src/home/lib/write-meta.mjs';
import { buildResult, COMPLETED_COMMAND, makeRun } from './meta/test-fixtures.mjs';

const cliPath = fileURLToPath(new URL('../src/home/lib/write-meta.mjs', import.meta.url));
const scoutAnswer = 'The reply points the operator at the structured read command so the run can be inspected '
  + 'without guessing artifact paths. The command reads the retained events and diagnostic output, '
  + 'and the same link remains available after a successful scout has explained the requested code.';
const cases = [
  { name: 'OK build', agent: 'codex-build', exit: 0, status: 'OK',
    options: { result: buildResult([]) } },
  { name: 'FAIL with result', agent: 'codex-build', exit: 0, status: 'FAIL',
    options: { result: buildResult([], { verify_passed: false }) } },
  { name: 'FAIL without result', agent: 'codex-build', exit: 1, status: 'FAIL',
    options: { stderr: 'panic: failed before result\n' } },
  { name: 'LIMIT', agent: 'codex-build', exit: 1, status: 'LIMIT',
    options: { events: [{ type: 'error', message: 'quota exhausted' }] } },
  { name: 'UNAVAILABLE', agent: 'codex-build', exit: 1, status: 'UNAVAILABLE',
    options: { events: [{ type: 'turn.failed', error: { message:
      'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header' } }] } },
  { name: 'OK scout', agent: 'codex-scout', exit: 0, status: 'OK',
    options: { result: { answer: scoutAnswer, findings: [], unknowns: [],
      report_markdown: '# report' } } },
  { name: 'OK review', agent: 'codex-review', exit: 0, status: 'OK',
    options: { file: 'review.json', result: { verdict: 'approve', findings: [] } } },
];

function recordedFiles(runDir) {
  const meta = fs.readFileSync(path.join(runDir, 'meta.json'));
  const status = fs.readFileSync(path.join(runDir, 'status.json'));
  return { meta, status, finishedAt: JSON.parse(status.toString('utf8')).finished_at };
}

for (const { name, agent, exit, status, options } of cases) {
  test(`renderReply preserves ${name} reply and recorded files before and after recovery`, () => {
    const runDir = makeRun({ args: ['exec', '--json'],
      events: [{ type: 'thread.started', thread_id: 'reply-render' }, COMPLETED_COMMAND], ...options });
    const { meta, reply } = collect(runDir, agent, exit);
    assert.equal(meta.status, status);
    if (name === 'FAIL without result') {
      assert.match(reply, /^Situation: /m);
      assert.match(reply, /^Continuation: /m);
    }

    const before = recordedFiles(runDir);
    assert.equal(before.finishedAt, meta.finished_at);
    assert.equal(renderReply(runDir, agent, meta), reply);
    assert.deepEqual(recordedFiles(runDir), before);

    // Plan_80 E17/O5a: recording the child must not trigger a new verdict or finish time.
    writeStatus(runDir, { recovery: { child: 'x', automatic: true } });
    const withRecovery = recordedFiles(runDir);
    assert.deepEqual(JSON.parse(withRecovery.status.toString('utf8')).recovery,
      { child: 'x', automatic: true });
    assert.deepEqual(withRecovery.meta, before.meta);
    assert.equal(withRecovery.finishedAt, before.finishedAt);
    assert.equal(renderReply(runDir, agent, meta), reply);
    assert.deepEqual(recordedFiles(runDir), withRecovery);
  });

  test(`direct CLI preserves ${name} reply including console.log newline`, () => {
    const runDir = makeRun({ args: ['exec', '--json'],
      events: [{ type: 'thread.started', thread_id: 'reply-render' }, COMPLETED_COMMAND], ...options });
    const { meta, reply } = collect(runDir, agent, exit);
    assert.equal(meta.status, status);
    const child = spawnSync(process.execPath, [cliPath, runDir, agent, String(exit)], { encoding: 'utf8' });
    assert.ifError(child.error);
    assert.equal(child.status, exitCodeFor(meta.status), child.stderr);
    assert.equal(child.stderr, '');
    assert.equal(child.stdout, `${reply}\n`);
  });
}

test('renderReply rejects an unknown agent with the same error as collect', () => {
  const runDir = makeRun();
  let expected;
  assert.throws(() => collect(runDir, 'unknown-agent', 0), (error) => {
    expected = error.message;
    return /^unknown agent: unknown-agent \(expected one of .+\)$/.test(expected);
  });
  assert.throws(() => renderReply(runDir, 'unknown-agent', {}), { message: expected });
});
