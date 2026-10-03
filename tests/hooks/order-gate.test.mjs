/** Verifies the producer-side PreToolUse gate and its safe diagnostics behavior. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { HOOK_DEFINITIONS, SUBAGENT_TOOLS } from '../../src/home/lib/hook-definitions.mjs';
import { taskFingerprint } from '../../src/home/lib/meta/chain.mjs';
import { createStoredRun, fixture, payload, runGate, validPrompt } from './order-gate-fixtures.mjs';

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

// Plan_59 C2: registry-derived gates must recognize advisor and accept its real scope phase.
test('advisor requires a phase at the order gate and accepts scope as a concrete input', async (t) => {
  const root = await fixture(t);
  const taskFile = path.join(root, 'task.md');
  await fs.writeFile(taskFile, '## Options\n- keep: Keep it.\n- split: Split it.\n## Paths\n- source.mjs\n');
  const prompt = validPrompt('advisor-order', taskFile);
  const missing = runGate(root, payload('codex-advisor', prompt));
  assert.equal(missing.status, 0);
  const decision = JSON.parse(missing.stdout).hookSpecificOutput;
  assert.equal(decision.permissionDecision, 'deny');
  assert.match(decision.permissionDecisionReason, /phase/);
  const present = runGate(root, payload('codex-advisor', `${prompt}\nphase: scope`));
  assert.equal(present.status, 0);
  assert.equal(present.stdout, '');
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
    JSON.parse(await fs.readFile(path.join(
      root, '.lyupro', '.codex-bridge', 'state', 'diagnostics', 'order-gate.last.json',
    ), 'utf8')),
    JSON.parse(input),
  );
  await assert.rejects(fs.access(path.join(root, '.claude', 'logs')), { code: 'ENOENT' });
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
    task_hash_scheme: 2,
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
  assert.match(reason, /with a different task/);
  assert.match(reason, /continue:\/retry: header line/);
  assert.doesNotMatch(reason, /cannot be compared/);
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

// Plan_75 D1, TradeForge capacity incident: a retry must reach the runner under its own order id.
test('retry and conflicting grants pass an order owned by a different-hash run to the runner', async (t) => {
  const root = await fixture(t);
  const repo = path.join(root, 'project');
  const taskFile = path.join(root, 'task.md');
  await fs.writeFile(taskFile, 'Repeated task\n');
  await createStoredRun(root, repo, 'failed-run', {
    order_id: 'retry-order',
    task_hash: taskFingerprint('Original task'),
    task_hash_scheme: 2,
    slug: 'failed-run',
    started_at: '2026-10-03T17:20:17.000Z',
  });

  for (const extra of [
    '\nretry: failed-run — model at capacity, same pass again',
    '\ncontinue: failed-run — next pass\nretry: failed-run — same pass again',
  ]) {
    const prompt = validPrompt('retry-order', taskFile, extra);
    const result = runGate(root, payload('codex-review', prompt, 'Agent', repo));
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '', extra);
  }
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
    task_hash_scheme: 2,
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

// Plan_62 D7: a teammate's agent_type is its name, so the dispatcher gate would not recognise it.
test('a dispatcher launched as a teammate is refused before it starts', async (t) => {
  const root = await fixture(t);
  const prompt = validPrompt('plan62-teammate-20260924', 'C:/abs/task.md');
  for (const field of ['name', 'team_name']) {
    const input = JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Agent',
      tool_input: { subagent_type: 'codex-scout', prompt, [field]: 'scout-1' },
      tool_use_id: 'toolu-test-order-gate',
    });
    const result = runGate(root, input);
    assert.equal(result.status, 0);
    const output = JSON.parse(result.stdout).hookSpecificOutput;
    assert.equal(output.permissionDecision, 'deny', field);
    assert.match(output.permissionDecisionReason, new RegExp(`passes \`${field}\``));
  }

  const blank = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'codex-scout', prompt, name: '  ' },
    tool_use_id: 'toolu-test-order-gate',
  });
  assert.equal(runGate(root, blank).stdout, '', 'a blank name is not a teammate');

  const unrelated = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'general-purpose', prompt: 'x', name: 'helper' },
  });
  assert.equal(runGate(root, unrelated).stdout, '', 'only registered dispatchers are refused');
});
