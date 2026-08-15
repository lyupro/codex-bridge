/** Verifies the producer-side PreToolUse gate and its safe diagnostics behavior. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HOOK_DEFINITIONS, SUBAGENT_TOOLS } from '../../src/home/lib/hook-definitions.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const GATE = path.join(ROOT, 'src', 'home', 'hooks', 'order-gate.mjs');

function runGate(root, input) {
  return spawnSync(process.execPath, [GATE], {
    input,
    encoding: 'utf8',
    env: { ...process.env, HOME: root, USERPROFILE: root },
  });
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-order-gate-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function payload(subagentType, prompt, toolName = 'Agent') {
  return JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: { subagent_type: subagentType, prompt },
    tool_use_id: 'toolu-test-order-gate',
  });
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
