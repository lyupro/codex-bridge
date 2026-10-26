/**
 * Verifies how the order gate treats order ownership and grants read from the task-file header.
 * Plan_63 D9 / OW-054: a grant may skip the different-task diagnostic only after the header and the order
 * validate, so `continue: none` in the call or the header can no longer disarm it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { taskFingerprint } from '../../src/home/lib/meta/chain.mjs';
import { createStoredRun, decodeDenial, fixture, gitRepositories, payload, runGate, validPrompt, writeTaskFile } from './order-gate-fixtures.mjs';

test('a conditional continuation grant is not an order-gate requirement', async (t) => {
  const root = await fixture(t);
  const taskFile = await writeTaskFile(root, `order id: plan-13-build-20260804\nscope: src/home/hooks/order-gate.mjs\nrepository: ${root}`, 'Requested task\n');
  const result = runGate(root, payload('codex-build', validPrompt(taskFile)));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('an order id owned by a different task is denied before dispatch', async (t) => {
  const root = await fixture(t);
  const repo = path.join(root, 'project');
  const taskFile = await writeTaskFile(root, `order id: plan-43-step-3\nrepository: ${repo}`, '# Task\nRequested task\n');
  const run = await createStoredRun(root, repo, 'run-two', {
    order_id: 'plan-43-step-3',
    task_hash: taskFingerprint('Different task'),
    task_hash_scheme: 2,
    slug: 'plan43-run-two',
    started_at: '2026-08-15T09:00:00.000Z',
  });

  const result = runGate(root, payload('codex-review', validPrompt(taskFile), 'Agent', repo));
  const reason = decodeDenial(result.stdout).permissionDecisionReason;
  assert.match(reason, /plan-43-step-3/);
  assert.match(reason, new RegExp(run.replaceAll('\\', '\\\\')));
  assert.match(reason, /plan43-run-two/);
  assert.match(reason, /2026-08-15T09:00:00\.000Z/);
  assert.match(reason, /new order id/);
  assert.match(reason, /with a different task/);
  assert.match(reason, /continue:\/retry: header line/);
  assert.doesNotMatch(reason, /cannot be compared/);
});

test('an explicit continuation grant permits a refined task under the same order id', async (t) => {
  const root = await fixture(t);
  const repo = path.join(root, 'project');
  const taskFile = await writeTaskFile(root, `order id: continued-order\ncontinue: continued-run — finish the remaining tests\nrepository: ${repo}`, 'Refined task\n');
  await createStoredRun(root, repo, 'continued-run', {
    order_id: 'continued-order',
    task_hash: taskFingerprint('Original task'),
    slug: 'continued-run',
    started_at: '2026-08-15T09:02:00.000Z',
  });

  const prompt = validPrompt(taskFile);
  const result = runGate(root, payload('codex-review', prompt, 'Agent', repo));
  assert.equal(result.stdout, '');
});

// Plan_75 D1, TradeForge capacity incident: a retry must reach the runner under its own order id.
test('valid retry and continue grants pass a different-hash owner to the runner; conflicting grants are denied', async (t) => {
  const root = await fixture(t);
  const repo = path.join(root, 'project');
  await createStoredRun(root, repo, 'failed-run', {
    order_id: 'retry-order',
    task_hash: taskFingerprint('Original task'),
    task_hash_scheme: 2,
    slug: 'failed-run',
    started_at: '2026-10-03T17:20:17.000Z',
  });

  for (const extra of ['retry: failed-run — model at capacity, same pass again', 'continue: failed-run — next pass']) {
    const taskFile = await writeTaskFile(root, `order id: retry-order\n${extra}\nrepository: ${repo}`, 'Repeated task\n');
    const prompt = validPrompt(taskFile);
    const result = runGate(root, payload('codex-review', prompt, 'Agent', repo));
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '', extra);
  }
  const taskFile = await writeTaskFile(root, 'order id: retry-order\ncontinue: failed-run — next pass\nretry: failed-run — same pass again', 'Repeated task\n');
  const decision = decodeDenial(runGate(root, payload('codex-review', validPrompt(taskFile), 'Agent', repo)).stdout);
  assert.equal(decision.permissionDecision, 'deny');
  assert.match(decision.permissionDecisionReason, /continue.*retry|retry.*continue/);
});

// Plan_63 D9 / OW-054: neither a call label nor a placeholder header grant may bypass validation.
test('continue none in the call or header cannot disarm the different-task owner check', async (t) => {
  const root = await fixture(t);
  const repo = path.join(root, 'project');
  const header = 'order id: guarded-order';
  const taskFile = await writeTaskFile(root, `${header}\nrepository: ${repo}`, 'Current task\n');
  await createStoredRun(root, repo, 'owner-run', {
    order_id: 'guarded-order', task_hash: taskFingerprint('Another task'), task_hash_scheme: 2,
    slug: 'owner-run', started_at: '2026-08-15T09:04:00.000Z',
  });
  const decisionFor = (prompt) => decodeDenial(runGate(root, payload('codex-review', prompt, 'Agent', repo)).stdout);
  const call = decisionFor(`${validPrompt(taskFile)}\ncontinue: none`);
  assert.equal(call.permissionDecision, 'deny');
  assert.match(call.permissionDecisionReason, /moved to the task-file header/);
  await writeTaskFile(root, `${header}\ncontinue: none`, 'Current task\n');
  const invalidHeader = decisionFor(validPrompt(taskFile));
  assert.equal(invalidHeader.permissionDecision, 'deny');
  assert.match(invalidHeader.permissionDecisionReason, /line 2:.*continue/);
  assert.match(invalidHeader.permissionDecisionReason, /placeholder/);
  assert.doesNotMatch(invalidHeader.permissionDecisionReason, /with a different task/);
  await writeTaskFile(root, 'continue: none', 'Current task\n');
  const headerFirst = decisionFor(validPrompt(taskFile));
  assert.equal(headerFirst.permissionDecision, 'deny');
  assert.match(headerFirst.permissionDecisionReason, /placeholder/);
  assert.doesNotMatch(headerFirst.permissionDecisionReason, /missing required header label/);
  await writeTaskFile(root, `${header}\nrepository: ${repo}`, 'Current task\n');
  const owner = decisionFor(validPrompt(taskFile));
  assert.equal(owner.permissionDecision, 'deny');
  assert.match(owner.permissionDecisionReason, /with a different task/);
});

test('a valid header grant cannot skip missing required order labels (OW-054)', async (t) => {
  const root = await fixture(t);
  for (const [agent, header, label] of [
    ['codex-review', 'continue: prior-run — finish the tests', 'order id'],
    ['codex-build', 'order id: grant-order\ncontinue: prior-run — finish the tests', 'scope'],
    ['codex-advisor', 'order id: grant-order\nretry: prior-run — repeat the pass', 'phase'],
  ]) {
    const taskFile = await writeTaskFile(root, header, 'Current task\n');
    const decision = decodeDenial(runGate(root, payload(agent, validPrompt(taskFile))).stdout);
    assert.equal(decision.permissionDecision, 'deny', agent);
    assert.ok(decision.permissionDecisionReason.includes(`missing required header label "${label}:"`), agent);
    assert.match(decision.permissionDecisionReason, /The run folder was not created; quota was not spent\./);
  }
  await assert.rejects(fs.access(path.join(root, 'runs')), { code: 'ENOENT' });
});

// OW-073: the task's worktree owns history even when the host launches from a different repo.
test('owner conflicts use repository A from the task file, never repository B from hook cwd', async (t) => {
  const root = await fixture(t);
  const [repoA, repoB] = await gitRepositories(root);
  const taskFile = await writeTaskFile(repoA, 'order id: task-repository-owner', 'Current task\n');
  const owner = {
    order_id: 'task-repository-owner', task_hash: taskFingerprint('Another task'), task_hash_scheme: 2,
    slug: 'repo-owner', started_at: '2026-10-26T09:00:00.000Z',
  };
  await createStoredRun(root, repoB, 'b-owner', owner);
  const input = payload('codex-review', validPrompt(taskFile), 'Agent', repoB);
  const onlyB = runGate(root, input);
  assert.equal(onlyB.status, 0, onlyB.stderr);
  assert.equal(onlyB.stdout, '', 'an owner stored only under B cannot claim a task in A');

  const ownerA = await createStoredRun(root, repoA, 'a-owner', owner);
  const inA = runGate(root, input);
  assert.equal(inA.status, 0, inA.stderr);
  const decision = decodeDenial(inA.stdout);
  assert.equal(decision.permissionDecision, 'deny');
  assert.match(decision.permissionDecisionReason, /with a different task/);
  assert.ok(decision.permissionDecisionReason.includes(ownerA));
  assert.doesNotMatch(decision.permissionDecisionReason, /b-owner/);
});

// OW-073: even a validated continuation must pass the same repository-source rule as the runner.
test('a repository B label on a task in A is denied before any continuation grant', async (t) => {
  const root = await fixture(t);
  const [repoA, repoB] = await gitRepositories(root);
  for (const grant of ['', '\ncontinue: prior-run — finish the remaining tests']) {
    const taskFile = await writeTaskFile(repoA,
      `order id: wrong-repository\nrepository: ${repoB}${grant}`, 'Requested task\n');
    const result = runGate(root, payload('codex-review', validPrompt(taskFile), 'Agent', repoB));
    assert.equal(result.status, 0, result.stderr);
    const decision = decodeDenial(result.stdout);
    assert.equal(decision.permissionDecision, 'deny');
    assert.match(decision.permissionDecisionReason, /task file worktree .* does not match repository label/);
    assert.ok(decision.permissionDecisionReason.includes(JSON.stringify(repoA)));
    assert.ok(decision.permissionDecisionReason.includes(JSON.stringify(repoB)));
    assert.match(decision.permissionDecisionReason, /fix the label or move the task file/);
    assert.match(decision.permissionDecisionReason, /The run folder was not created; quota was not spent\./);
  }
  await assert.rejects(fs.access(path.join(root, 'runs')), { code: 'ENOENT' });
});
