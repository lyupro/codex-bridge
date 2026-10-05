/** Verifies the producer-side PreToolUse gate and its safe diagnostics behavior. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AGENTS } from '../../src/home/lib/agents.mjs';
import { HOOK_DEFINITIONS, SUBAGENT_TOOLS } from '../../src/home/lib/hook-definitions.mjs';
import { taskFingerprint } from '../../src/home/lib/meta/chain.mjs';
import { createStoredRun, fixture, payload, runGate, validPrompt, writeTaskFile } from './order-gate-fixtures.mjs';

test('missing header order id and scope are denied with actionable details', async (t) => {
  const root = await fixture(t);
  const taskFile = await writeTaskFile(root, 'advice: mechanical', 'Requested task\n');
  const result = runGate(root, payload('codex-build', validPrompt(taskFile)));
  assert.equal(result.status, 0);
  const decision = JSON.parse(result.stdout).hookSpecificOutput;
  assert.equal(decision.hookEventName, 'PreToolUse');
  assert.equal(decision.permissionDecision, 'deny');
  assert.equal(decision.permissionDecisionReason.split('\n')[0], 'missing required header label "order id:"; example: order id: plan-13-build-20260804');
  assert.match(decision.permissionDecisionReason, /missing required header label "scope:"; example: scope: /);
  assert.match(decision.permissionDecisionReason, /order id/);
  assert.match(decision.permissionDecisionReason, /scope/);
  assert.match(decision.permissionDecisionReason, /plan-13-build-20260804/);
  assert.match(decision.permissionDecisionReason, /src\/home\/lib\/runner\/\*\*/);
  assert.match(decision.permissionDecisionReason, /The run folder was not created; quota was not spent\./);
  assert.doesNotMatch(decision.permissionDecisionReason, /found `/);
});

// Plan_59 C2: registry-derived gates must recognize advisor and accept its real scope phase.
test('advisor requires a phase at the order gate and accepts scope as a concrete input', async (t) => {
  const root = await fixture(t);
  const body = '## Options\n- keep: Keep it.\n- split: Split it.\n## Paths\n- source.mjs\n';
  const taskFile = await writeTaskFile(root, 'order id: advisor-order', body);
  const prompt = validPrompt(taskFile);
  const missing = runGate(root, payload('codex-advisor', prompt));
  assert.equal(missing.status, 0);
  const decision = JSON.parse(missing.stdout).hookSpecificOutput;
  assert.equal(decision.permissionDecision, 'deny');
  assert.match(decision.permissionDecisionReason, /missing required header label "phase:"/);
  assert.match(decision.permissionDecisionReason, /phase: scope/);
  await writeTaskFile(root, 'order id: advisor-order\nphase: scope', body);
  const present = runGate(root, payload('codex-advisor', prompt));
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
  const taskFile = await writeTaskFile(root, 'order id: <order id from the orchestrator>\nscope: TODO', 'Requested task\n');
  const result = runGate(root, payload('codex-build', validPrompt(taskFile)));
  const decision = JSON.parse(result.stdout).hookSpecificOutput;
  assert.equal(decision.permissionDecision, 'deny');
  assert.match(decision.permissionDecisionReason, /order id/);
  assert.match(decision.permissionDecisionReason, /scope/);
  assert.match(decision.permissionDecisionReason, /still a placeholder/);
});

test('a relative task file is denied before the dispatcher starts', async (t) => {
  const root = await fixture(t);
  const result = runGate(root, payload('codex-review', 'task file: task.md'));
  const decision = JSON.parse(result.stdout).hookSpecificOutput;
  assert.equal(decision.permissionDecision, 'deny');
  assert.match(decision.permissionDecisionReason, /task file/);
  assert.match(decision.permissionDecisionReason, /absolute path/);
});

test('scope prose and its bullet are refused as call lines, with task file still missing', async (t) => {
  const root = await fixture(t);
  const result = runGate(root, payload(
    'codex-build',
    'scope (you may create/modify ONLY these):\n- assets/vault/.claude/lib/sessions.py (new)',
  ));
  const decision = JSON.parse(result.stdout).hookSpecificOutput;
  const reason = decision.permissionDecisionReason;
  assert.equal(decision.permissionDecision, 'deny');
  assert.match(reason, /line 1: `scope \(you may create\/modify ONLY these\):` — not a `label: value` line/);
  assert.match(reason, /line 2: `- assets\/vault\/\.claude\/lib\/sessions\.py \(new\)` — not a `label: value` line/);
  assert.match(reason, /missing required label `task file`/);
});

// Plan_76 D1, 2026-10-04: aliases and repository prose must be refused before dispatch.
test('non-registry and former order call lines are denied', async (t) => {
  const root = await fixture(t);
  const prompt = validPrompt('C:/abs/task.md');
  for (const [line, expected] of [
    ['scope-new: src/', /moved to the task-file header/],
    ['Repository root: C:/x', /not a `label: value` line; free text belongs in the task file/],
    ['order-id: a1', /moved to the task-file header/],
    ['order id: a2', /moved to the task-file header/],
    ['scope: src/', /moved to the task-file header/],
    ['task file: C:/abs/other.md', /label `task file` is given twice/],
  ]) {
    const result = runGate(root, payload('codex-build', `${prompt}\n${line}`));
    assert.equal(result.status, 0, line);
    const decision = JSON.parse(result.stdout).hookSpecificOutput;
    assert.equal(decision.permissionDecision, 'deny', line);
    assert.match(decision.permissionDecisionReason, expected, line);
  }
});

test('changeset is accepted for review and refused for scout', async (t) => {
  const root = await fixture(t);
  const taskFile = await writeTaskFile(root, 'order id: changeset-order\nchangeset: base:main', 'Requested task\n');
  const prompt = validPrompt(taskFile);
  const review = runGate(root, payload('codex-review', prompt));
  assert.equal(review.status, 0);
  assert.equal(review.stdout, '');
  const scout = runGate(root, payload('codex-scout', prompt));
  assert.equal(scout.status, 0);
  const decision = JSON.parse(scout.stdout).hookSpecificOutput;
  assert.equal(decision.permissionDecision, 'deny');
  assert.match(decision.permissionDecisionReason, /label "changeset" is not accepted by codex-scout/);
});

test('every agent accepts shared optional labels and only build accepts scope new', async (t) => {
  const root = await fixture(t);
  for (const type of Object.keys(AGENTS)) {
    let header = 'order id: optional-order';
    if (type === 'codex-build') header += '\nscope: src/';
    if (type === 'codex-advisor') header += '\nphase: scope';
    header += '\nrepository: C:/x\nslug: optional-labels\neffort: medium';
    const taskFile = await writeTaskFile(root, header, 'Requested task\n');
    const prompt = validPrompt(taskFile);
    const shared = runGate(root, payload(type, prompt));
    assert.equal(shared.status, 0, type);
    assert.equal(shared.stdout, '', type);
    await writeTaskFile(root, `${header}\nscope new: src/new.mjs`, 'Requested task\n');
    const scopeNew = runGate(root, payload(type, prompt));
    assert.equal(scopeNew.status, 0, type);
    if (type === 'codex-build') {
      assert.equal(scopeNew.stdout, '', type);
    } else {
      const decision = JSON.parse(scopeNew.stdout).hookSpecificOutput;
      assert.equal(decision.permissionDecision, 'deny', type);
      assert.match(decision.permissionDecisionReason, /label "scope new" is not accepted by/);
    }
  }
});

test('a valid dispatcher call passes and keeps the last payload', async (t) => {
  const root = await fixture(t);
  const taskFile = await writeTaskFile(root, 'order id: plan-13-build-20260804\nscope: src/home/hooks/order-gate.mjs', 'Requested task\n');
  const input = payload('codex-build', validPrompt(taskFile));
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

test('order collision diagnostics fail open on unreadable or absent disk state', async (t) => {
  const root = await fixture(t);
  const repo = path.join(root, 'project');
  const missingTask = path.join(root, 'missing-task.md');
  const unreadableTask = runGate(root, payload('codex-review', validPrompt(missingTask), 'Agent', repo));
  assert.equal(unreadableTask.stdout, '');

  const taskFile = await writeTaskFile(root, 'order id: no-runs-directory', 'Readable task\n');
  const missingRuns = runGate(root, payload('codex-review', validPrompt(taskFile), 'Agent', repo));
  assert.equal(missingRuns.stdout, '');
});

test('a stored run without task_hash does not claim a different task', async (t) => {
  const root = await fixture(t);
  const repo = path.join(root, 'project');
  const taskFile = await writeTaskFile(root, 'order id: legacy-order', 'Current task\n');
  await createStoredRun(root, repo, 'legacy-run', {
    order_id: 'legacy-order',
    slug: 'legacy-run',
    started_at: '2026-08-15T09:03:00.000Z',
  });

  const result = runGate(root, payload('codex-review', validPrompt(taskFile), 'Agent', repo));
  assert.equal(result.stdout, '');
});

test('a folder without status.json does not disarm the collision check', async (t) => {
  const root = await fixture(t);
  const repo = path.join(root, 'project');
  const taskFile = await writeTaskFile(root, 'order id: guarded-order', 'Current task\n');
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

  const result = runGate(root, payload('codex-review', validPrompt(taskFile), 'Agent', repo));
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
  const taskFile = await writeTaskFile(root, 'order id: plan62-teammate-20260924', 'Requested task\n');
  const prompt = validPrompt(taskFile);
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
