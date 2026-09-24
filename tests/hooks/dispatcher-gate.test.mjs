import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readHandbackWitness } from '../../src/home/lib/handback-witness.mjs';
import { canonicalRunCommand } from '../../src/home/lib/dispatcher-command.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const GATE = path.join(ROOT, 'src', 'home', 'hooks', 'dispatcher-gate.mjs');
const ORDER = 'order id: order-62\nscope: src/home\ntask file: C:/abs/task.md';
const COMMAND = canonicalRunCommand('codex-build', ORDER).command;

function runGate(root, payload) {
  return spawnSync(process.execPath, [GATE], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, CODEX_BRIDGE_HOME: path.join(root, 'home') },
  });
}

async function fixture(t) {
  const root = makeTempTree('bridge-dispatcher-gate-');
  t.after(() => removeTempTree(root));
  return root;
}

async function addTranscript(root, sessionId = 'session-62', agentId = 'agent-62') {
  const transcriptPath = path.join(root, 'parent.jsonl');
  const agentPath = path.join(root, sessionId, 'subagents', `agent-${agentId}.jsonl`);
  await fs.mkdir(path.dirname(agentPath), { recursive: true });
  await fs.writeFile(agentPath, `${JSON.stringify({
    type: 'user', message: { content: ORDER },
  })}\n`);
  return { transcript_path: transcriptPath, session_id: sessionId, agent_id: agentId };
}

function dispatcherPayload(identity, toolName, toolInput = {}, event = 'PreToolUse') {
  return {
    ...identity,
    agent_type: 'codex-build',
    hook_event_name: event,
    tool_name: toolName,
    tool_input: toolInput,
  };
}

function outcome(root, payload) {
  const result = runGate(root, payload);
  assert.equal(result.status, 0, result.stderr);
  return result;
}

function hookOutput(result) {
  return JSON.parse(result.stdout).hookSpecificOutput;
}

test('TradeForge replay blocks tools and rejects a repeated handback without delegation', async (t) => {
  const root = await fixture(t);
  const identity = await addTranscript(root);
  const commands = [
    'cat C:/abs/task.md',
    'cat > C:/abs/task.md <<\'EOF\'\nreplacement\nEOF',
  ];
  for (const command of commands) {
    const result = outcome(root, dispatcherPayload(identity, 'Bash', { command }));
    const output = hookOutput(result);
    assert.equal(output.permissionDecision, 'deny');
    assert.ok(output.permissionDecisionReason.includes(`\n${COMMAND}\n`));
  }

  const write = outcome(root, dispatcherPayload(identity, 'Write', { file_path: 'C:/abs/task.md' }));
  assert.equal(hookOutput(write).permissionDecision, 'deny');

  const handback = () => dispatcherPayload(identity, 'SubagentHandback', { message: 'OK — done' });
  assert.equal(hookOutput(outcome(root, handback())).permissionDecision, 'deny');
  const repeated = hookOutput(outcome(root, handback()));
  assert.equal(repeated.permissionDecision, 'allow');
  assert.match(repeated.updatedInput.message, /^FAIL — dispatcher did not delegate:/);
  assert.ok(repeated.updatedInput.message.includes(COMMAND));
});

test('honest runner output replaces handback with the final failure verdict', async (t) => {
  const root = await fixture(t);
  const identity = await addTranscript(root);
  const launch = outcome(root, dispatcherPayload(identity, 'Bash', { command: COMMAND }));
  assert.equal(launch.stdout, '');

  const startedPayload = dispatcherPayload(identity, 'Bash', { command: COMMAND }, 'PostToolUse');
  startedPayload.tool_response = { stdout: 'STARTED run-62\nRunner continues.' };
  outcome(root, startedPayload);

  const pending = hookOutput(outcome(root, dispatcherPayload(identity, 'SubagentHandback', { message: 'STARTED run-62' })));
  assert.equal(pending.permissionDecision, 'deny');
  assert.ok(pending.permissionDecisionReason.includes(`\n${COMMAND}\n`));

  const failure = dispatcherPayload(identity, 'Bash', { command: COMMAND }, 'PostToolUseFailure');
  failure.error = 'Exit code 1\nFAIL — boom';
  assert.equal(outcome(root, failure).stdout, '');

  const final = hookOutput(outcome(root, dispatcherPayload(identity, 'SubagentHandback', { message: 'OK — misleading' })));
  assert.equal(final.permissionDecision, 'allow');
  assert.equal(final.updatedInput.message, 'FAIL — boom');
  const witness = await readHandbackWitness({ stateDir: path.join(root, 'home', 'state') });
  assert.ok(witness.lastSeen);
});

test('main-session and unregistered agent payloads are ignored', async (t) => {
  const root = await fixture(t);
  const identity = await addTranscript(root);
  const main = dispatcherPayload(identity, 'Write');
  delete main.agent_type;
  assert.equal(outcome(root, main).stdout, '');

  const unknown = dispatcherPayload(identity, 'Write');
  unknown.agent_type = 'unregistered-agent';
  assert.equal(outcome(root, unknown).stdout, '');
});

test('a missing agent transcript denies tools and returns a fail-closed handback', async (t) => {
  const root = await fixture(t);
  const identity = { transcript_path: path.join(root, 'parent.jsonl'), session_id: 'missing-session', agent_id: 'missing-agent' };
  const bash = hookOutput(outcome(root, dispatcherPayload(identity, 'Bash', { command: 'cat C:/abs/task.md' })));
  assert.equal(bash.permissionDecision, 'deny');
  assert.match(bash.permissionDecisionReason, /nothing may run, so hand back now/);

  const write = hookOutput(outcome(root, dispatcherPayload(identity, 'Write')));
  assert.equal(write.permissionDecision, 'deny');
  const handback = hookOutput(outcome(root, dispatcherPayload(identity, 'SubagentHandback', { message: 'OK — done' })));
  assert.equal(handback.permissionDecision, 'allow');
  assert.match(handback.updatedInput.message, /^FAIL — dispatcher gate: the order could not be read from the agent transcript/);
});
