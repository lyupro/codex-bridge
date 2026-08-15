/** Verifies the producer-side PreToolUse gate and its safe diagnostics behavior. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HOOK_DEFINITIONS, SUBAGENT_TOOLS } from '../../src/home/lib/hook-definitions.mjs';
import { taskFingerprint } from '../../src/home/lib/meta/chain.mjs';
import { parseTaskDocument } from '../../src/home/lib/runner/task-file.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const GATE = path.join(ROOT, 'src', 'home', 'hooks', 'order-gate.mjs');

function runGate(root, input) {
  return spawnSync(process.execPath, [GATE], {
    input,
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_RUNS_ROOT: path.join(root, 'runs'),
      HOME: root,
      USERPROFILE: root,
    },
  });
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-order-gate-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function payload(subagentType, prompt, toolName = 'Agent', cwd = undefined) {
  return JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: { subagent_type: subagentType, prompt },
    tool_use_id: 'toolu-test-order-gate',
    cwd,
  });
}

function validPrompt(orderId, taskFile, continuation = '') {
  return `order id: ${orderId}\ntask file: ${taskFile}${continuation}`;
}

async function createStoredRun(root, repo, name, status) {
  const runs = path.join(root, 'runs', 'project');
  const run = path.join(runs, name);
  await fs.mkdir(run, { recursive: true });
  await fs.writeFile(path.join(runs, '.project.json'), `${JSON.stringify({ repo })}\n`);
  await fs.writeFile(path.join(run, 'status.json'), `${JSON.stringify(status)}\n`);
  return run;
}

test('missing dispatcher inputs are denied with actionable details', async (t) => {
  const root = await fixture(t);
  const result = runGate(root, payload('codex-build', ''));
  assert.equal(result.status, 0);
  const decision = JSON.parse(result.stdout).hookSpecificOutput;
  assert.equal(decision.hookEventName, 'PreToolUse');
  assert.equal(decision.permissionDecision, 'deny');
  assert.match(decision.permissionDecisionReason, /order id/);
  assert.match(decision.permissionDecisionReason, /scope/);
  assert.match(decision.permissionDecisionReason, /plan-13-build-20260804/);
  assert.match(decision.permissionDecisionReason, /src\/home\/lib\/runner\/\*\*/);
  assert.match(decision.permissionDecisionReason, /tool_input\.prompt/);
  assert.doesNotMatch(decision.permissionDecisionReason, /found `/);
});

/**
 * The gate answers to every name a host gives the subagent-launching tool. A gate that knows
 * only the local name is silent on every other host, and silence there reads exactly like
 * approval — the failure this whole mechanism exists to end.
 */
test('every registered subagent tool name reaches the gate', async (t) => {
  const root = await fixture(t);
  for (const toolName of SUBAGENT_TOOLS) {
    const result = runGate(root, payload('codex-build', '', toolName));
    assert.equal(result.status, 0);
    const decision = JSON.parse(result.stdout).hookSpecificOutput;
    assert.equal(decision.permissionDecision, 'deny', `${toolName} must reach the gate`);
  }
});

/** The installed matcher and the names the gate checks are one list, not two that can drift. */
test('the PreToolUse matcher matches exactly the tool names the gate answers to', () => {
  const definition = HOOK_DEFINITIONS.find((entry) => entry.file === 'order-gate.mjs');
  const matcher = new RegExp(`^(?:${definition.matcher})$`);
  for (const toolName of SUBAGENT_TOOLS) {
    assert.ok(matcher.test(toolName), `${toolName} must be covered by the registered matcher`);
  }
});

test('placeholder values are denied as missing inputs', async (t) => {
  const root = await fixture(t);
  const result = runGate(root, payload(
    'codex-build',
    'order id: <order id from the orchestrator>\nscope: TODO',
  ));
  const decision = JSON.parse(result.stdout).hookSpecificOutput;
  assert.equal(decision.permissionDecision, 'deny');
  assert.match(decision.permissionDecisionReason, /order id/);
  assert.match(decision.permissionDecisionReason, /scope/);
});

test('a relative task file is denied before the dispatcher starts', async (t) => {
  const root = await fixture(t);
  const result = runGate(root, payload(
    'codex-review',
    'order id: relative-task-file\ntask file: task.md',
  ));
  const decision = JSON.parse(result.stdout).hookSpecificOutput;
  assert.equal(decision.permissionDecision, 'deny');
  assert.match(decision.permissionDecisionReason, /found `task file: task\.md`, value `task\.md` is not an absolute path/);
});

test('diagnosis appears only beneath the missing entry whose label has a candidate', async (t) => {
  const root = await fixture(t);
  const result = runGate(root, payload(
    'codex-build',
    'scope (you may create/modify ONLY these):\n- assets/vault/.claude/lib/sessions.py (new)',
  ));
  const decision = JSON.parse(result.stdout).hookSpecificOutput;
  const reason = decision.permissionDecisionReason;
  const scopeEntry = reason.indexOf('- scope:');
  const diagnosis = reason.indexOf('found `scope (you may create/modify ONLY these):`, expected `scope:` with nothing between the label and the colon');
  assert.equal(decision.permissionDecision, 'deny');
  assert.match(reason, /- order id:/);
  assert.ok(scopeEntry >= 0);
  assert.ok(diagnosis > scopeEntry);
  assert.equal(reason.indexOf('found `order id'), -1);
});

test('a valid dispatcher call passes and keeps the last payload', async (t) => {
  const root = await fixture(t);
  const input = payload(
    'codex-build',
    'order id: plan-13-build-20260804\nscope: src/home/hooks/order-gate.mjs\n'
      + 'task file: C:/Users/me/AppData/Local/Temp/claude/s/scratchpad/task-plan-13.md',
  );
  const result = runGate(root, input);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(root, '.claude', 'logs', 'codex-order-gate.last.json'), 'utf8')),
    JSON.parse(input),
  );
});

test('a conditional continuation grant is not an order-gate requirement', async (t) => {
  const root = await fixture(t);
  const result = runGate(
    root,
    payload(
      'codex-build',
      'order id: plan-13-build-20260804\nscope: src/home/hooks/order-gate.mjs\n'
        + 'task file: C:/Users/me/AppData/Local/Temp/claude/s/scratchpad/task-plan-13.md\ncontinue: TODO',
    ),
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('an order id owned by a different task is denied before dispatch', async (t) => {
  const root = await fixture(t);
  const repo = path.join(root, 'project');
  const taskFile = path.join(root, 'task.md');
  await fs.writeFile(taskFile, '# Task\nRequested task\n');
  const run = await createStoredRun(root, repo, 'run-two', {
    order_id: 'plan-43-step-3',
    task_hash: taskFingerprint('Different task'),
    slug: 'plan43-run-two',
    started_at: '2026-08-15T09:00:00.000Z',
  });

  const result = runGate(root, payload(
    'codex-review',
    validPrompt('plan-43-step-3', taskFile),
    'Agent',
    repo,
  ));
  const reason = JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /plan-43-step-3/);
  assert.match(reason, new RegExp(run.replaceAll('\\', '\\\\')));
  assert.match(reason, /plan43-run-two/);
  assert.match(reason, /2026-08-15T09:00:00\.000Z/);
  assert.match(reason, /new order id/);
  assert.match(reason, /explicit continuation/);
});

test('an order id may repeat the same parsed task', async (t) => {
  const root = await fixture(t);
  const repo = path.join(root, 'project');
  const taskFile = path.join(root, 'task.md');
  const taskText = '# Task\nRequested task\n\n## Verify\nnpm test\n';
  await fs.writeFile(taskFile, taskText);
  await createStoredRun(root, repo, 'matching-run', {
    order_id: 'same-order',
    task_hash: taskFingerprint(parseTaskDocument(taskText).task),
    slug: 'matching-run',
    started_at: '2026-08-15T09:01:00.000Z',
  });

  const result = runGate(root, payload('codex-review', validPrompt('same-order', taskFile), 'Agent', repo));
  assert.equal(result.stdout, '');
});

test('an explicit continuation grant permits a refined task under the same order id', async (t) => {
  const root = await fixture(t);
  const repo = path.join(root, 'project');
  const taskFile = path.join(root, 'task.md');
  await fs.writeFile(taskFile, 'Refined task\n');
  await createStoredRun(root, repo, 'continued-run', {
    order_id: 'continued-order',
    task_hash: taskFingerprint('Original task'),
    slug: 'continued-run',
    started_at: '2026-08-15T09:02:00.000Z',
  });

  const prompt = validPrompt(
    'continued-order',
    taskFile,
    '\ncontinue: continued-run — finish the remaining tests',
  );
  const result = runGate(root, payload('codex-review', prompt, 'Agent', repo));
  assert.equal(result.stdout, '');
});

test('order collision diagnostics fail open on unreadable or absent disk state', async (t) => {
  const root = await fixture(t);
  const repo = path.join(root, 'project');
  const missingTask = path.join(root, 'missing-task.md');
  const unreadableTask = runGate(
    root,
    payload('codex-review', validPrompt('unreadable-task', missingTask), 'Agent', repo),
  );
  assert.equal(unreadableTask.stdout, '');

  const taskFile = path.join(root, 'task.md');
  await fs.writeFile(taskFile, 'Readable task\n');
  const missingRuns = runGate(
    root,
    payload('codex-review', validPrompt('no-runs-directory', taskFile), 'Agent', repo),
  );
  assert.equal(missingRuns.stdout, '');
});

test('a stored run without task_hash does not claim a different task', async (t) => {
  const root = await fixture(t);
  const repo = path.join(root, 'project');
  const taskFile = path.join(root, 'task.md');
  await fs.writeFile(taskFile, 'Current task\n');
  await createStoredRun(root, repo, 'legacy-run', {
    order_id: 'legacy-order',
    slug: 'legacy-run',
    started_at: '2026-08-15T09:03:00.000Z',
  });

  const result = runGate(root, payload('codex-review', validPrompt('legacy-order', taskFile), 'Agent', repo));
  assert.equal(result.stdout, '');
});

test('a folder without status.json does not disarm the collision check', async (t) => {
  const root = await fixture(t);
  const repo = path.join(root, 'project');
  const taskFile = path.join(root, 'task.md');
  await fs.writeFile(taskFile, 'Current task\n');
  const run = await createStoredRun(root, repo, 'owner-run', {
    order_id: 'guarded-order',
    task_hash: taskFingerprint('Another task'),
    slug: 'owner-run',
    started_at: '2026-08-15T09:04:00.000Z',
  });
  // A run folder exists for a moment before its status.json does, and the runs directory keeps
  // leftovers besides. Reading them all in one try made a single such folder switch the gate off.
  await fs.mkdir(path.join(root, 'runs', 'project', 'half-written-run'), { recursive: true });

  const result = runGate(root, payload('codex-review', validPrompt('guarded-order', taskFile), 'Agent', repo));
  const reason = JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, new RegExp(run.replaceAll('\\', '\\\\')));
});

test('non-Codex subagents pass silently', async (t) => {
  const root = await fixture(t);
  const result = runGate(root, payload('Explore', ''));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('malformed payloads pass silently', async (t) => {
  const root = await fixture(t);
  const result = runGate(root, '{');
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('non-subagent tools pass silently', async (t) => {
  const root = await fixture(t);
  const result = runGate(root, payload('codex-build', '', 'Bash'));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});
