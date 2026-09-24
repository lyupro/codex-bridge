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

async function seenToolUseIds(root) {
  const stateRoot = path.join(root, 'home', 'state');
  async function findIn(value) {
    if (!value || typeof value !== 'object') return null;
    if (Array.isArray(value.seenToolUseIds)) return value.seenToolUseIds;
    for (const child of Object.values(value)) {
      const found = await findIn(child);
      if (found) return found;
    }
    return null;
  }
  async function visit(directory) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        const found = await visit(file);
        if (found) return found;
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        const found = await findIn(JSON.parse(await fs.readFile(file, 'utf8')));
        if (found) return found;
      }
    }
    return null;
  }
  return visit(stateRoot);
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

test('PreToolUse receipts cover pass, deny, and allow decisions', async (t) => {
  const root = await fixture(t);
  const identity = await addTranscript(root);

  const pass = dispatcherPayload(identity, 'Bash', { command: COMMAND });
  pass.tool_use_id = 'receipt-pass';
  assert.equal(outcome(root, pass).stdout, '');
  assert.deepEqual(await seenToolUseIds(root), ['receipt-pass']);

  const deny = dispatcherPayload(identity, 'Bash', { command: 'cat C:/abs/task.md' });
  deny.tool_use_id = 'receipt-deny';
  assert.equal(hookOutput(outcome(root, deny)).permissionDecision, 'deny');
  assert.deepEqual(await seenToolUseIds(root), ['receipt-pass', 'receipt-deny']);

  const launch = dispatcherPayload(identity, 'Bash', { command: COMMAND });
  launch.tool_use_id = 'receipt-launch';
  assert.equal(outcome(root, launch).stdout, '');
  const completed = dispatcherPayload(identity, 'Bash', { command: COMMAND }, 'PostToolUse');
  completed.tool_response = { stdout: 'OK — runner completed' };
  outcome(root, completed);

  const handback = dispatcherPayload(identity, 'SubagentHandback', { message: 'OK' });
  handback.tool_use_id = 'receipt-allow';
  assert.equal(hookOutput(outcome(root, handback)).permissionDecision, 'allow');
  assert.deepEqual(await seenToolUseIds(root), [
    'receipt-pass', 'receipt-deny', 'receipt-launch', 'receipt-allow',
  ]);
});

test('PreToolUse receipts retain only the newest 200 IDs', async (t) => {
  const root = await fixture(t);
  const identity = await addTranscript(root);
  for (let index = 1; index <= 201; index += 1) {
    const payload = dispatcherPayload(identity, 'Bash', { command: 'cat C:/abs/task.md' });
    payload.tool_use_id = `receipt-${index}`;
    assert.equal(hookOutput(outcome(root, payload)).permissionDecision, 'deny');
  }
  const receipts = await seenToolUseIds(root);
  assert.equal(receipts.length, 200);
  assert.equal(receipts[0], 'receipt-2');
  assert.equal(receipts.at(-1), 'receipt-201');
});

test('a PreToolUse payload without a tool_use_id still decides and records no receipt', async (t) => {
  const root = await fixture(t);
  const identity = await addTranscript(root);
  const denied = hookOutput(outcome(root, dispatcherPayload(
    identity, 'Bash', { command: 'cat C:/abs/task.md' },
  )));
  assert.equal(denied.permissionDecision, 'deny');
  assert.equal(await seenToolUseIds(root), null);
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
