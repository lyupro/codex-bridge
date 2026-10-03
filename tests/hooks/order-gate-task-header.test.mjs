/** Plan_75 D5: the producer hook reads the same task header and header-free hash as the runner. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { taskFingerprint } from '../../src/home/lib/meta/chain.mjs';
import { parseTaskDocument } from '../../src/home/lib/runner/task-file.mjs';
import { createStoredRun, fixture, payload, runGate, validPrompt } from './order-gate-fixtures.mjs';

// Plan_75 D5: the producer must hash the same header-free body as the runner.
test('an order id may repeat the same parsed task with an advice header', async (t) => {
  const root = await fixture(t);
  const repo = path.join(root, 'project');
  const taskFile = path.join(root, 'task.md');
  const body = '# Task\nRequested task\n\n## Verify\nnpm test\n';
  const taskText = `advice: mechanical\n\n${body}`;
  await fs.writeFile(taskFile, taskText);
  await createStoredRun(root, repo, 'matching-run', {
    order_id: 'same-order',
    task_hash: taskFingerprint(parseTaskDocument(body).task),
    task_hash_scheme: 2,
    slug: 'matching-run',
    started_at: '2026-08-15T09:01:00.000Z',
  });

  const result = runGate(root, payload('codex-review', validPrompt('same-order', taskFile), 'Agent', repo));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

// Plan_75 D5: a repeat collecting an old answer must not be called a different task.
test('a pre-scheme owner is denied honestly when the same body has a different old hash', async (t) => {
  const root = await fixture(t);
  const repo = path.join(root, 'project');
  const taskFile = path.join(root, 'task.md');
  const taskText = 'advice: mechanical\n\n# Task\nRequested task\n';
  const oldHash = taskFingerprint(parseTaskDocument(taskText).task);
  assert.notEqual(oldHash, taskFingerprint(parseTaskDocument('# Task\nRequested task\n').task));
  await fs.writeFile(taskFile, taskText);
  const run = await createStoredRun(root, repo, 'pre-header-run', {
    order_id: 'old-order', task_hash: oldHash, slug: 'pre-header-run', started_at: '2026-08-15T09:01:00.000Z',
  });
  const decision = JSON.parse(runGate(root, payload('codex-review', validPrompt('old-order', taskFile), 'Agent', repo)).stdout).hookSpecificOutput;
  assert.equal(decision.permissionDecision, 'deny');
  assert.match(decision.permissionDecisionReason, /recorded before the task header \(hash scheme 2\), so its task cannot be compared/);
  assert.ok(decision.permissionDecisionReason.includes(`codex-bridge read "${run}"`));
  assert.doesNotMatch(decision.permissionDecisionReason, /different task/);
});

// Plan_75 D5, 2026-10-03 20:42: misplaced grants must be refused even without readable runs.
test('a misplaced grant is denied before the fail-open runs-folder check', async (t) => {
  const root = await fixture(t);
  const taskFile = path.join(root, 'task.md');
  await fs.writeFile(taskFile, 'Requested task\ncontinue: prior-run — finish the remaining tests\n');
  const decision = JSON.parse(runGate(root,
    payload('codex-review', validPrompt('misplaced-order', taskFile), 'Agent', path.join(root, 'project'))).stdout).hookSpecificOutput;
  assert.equal(decision.permissionDecision, 'deny');
  assert.match(decision.permissionDecisionReason, /line 2: misplaced continue metadata/);
  assert.match(decision.permissionDecisionReason, /move it into the header at the top of the file/);
  assert.match(decision.permissionDecisionReason, /The run folder was not created; quota was not spent/);
  await assert.rejects(fs.access(path.join(root, 'runs')), { code: 'ENOENT' });
});
