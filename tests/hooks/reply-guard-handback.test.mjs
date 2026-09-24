import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { readDispatcherState, updateDispatcherState } from '../../src/home/lib/dispatcher-state.mjs';
import { HANDBACK_TOOL } from '../../src/home/lib/hook-definitions.mjs';
import { readHandbackWitness } from '../../src/home/lib/handback-witness.mjs';
import { handbackDemandReason, missingRunReason } from '../../src/home/hooks/reply-verdicts.mjs';
import { withTempTree } from '../temp-tree.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const GUARD = path.join(ROOT, 'src', 'home', 'hooks', 'reply-guard.mjs');
const SESSION_ID = 'test-session';
const AGENT_ID = 'test-dispatcher';

async function writeTranscript(root, toolUses = []) {
  const transcriptPath = path.join(root, 'agent-transcript.jsonl');
  const content = JSON.stringify({
    type: 'assistant',
    message: { content: toolUses.map(({ id, name }) => ({ type: 'tool_use', id, name })) },
  });
  await fs.writeFile(transcriptPath, `${content}\n`);
  return transcriptPath;
}

async function writeState(stateDir, state) {
  return updateDispatcherState({ stateDir, sessionId: SESSION_ID, agentId: AGENT_ID }, (current) => ({
    ...current,
    ...state,
  }));
}

async function stateDirsFor(root) {
  const bridgeHome = path.join(root, 'bridge-home');
  const previousHome = process.env.CODEX_BRIDGE_HOME;
  process.env.CODEX_BRIDGE_HOME = bridgeHome;
  const moduleUrl = new URL('../../src/home/lib/brand-home.mjs', import.meta.url);
  moduleUrl.searchParams.set('test-home', bridgeHome);
  try {
    const { BRAND_STATE_DIR } = await import(moduleUrl.href);
    return { bridgeHome, stateDir: BRAND_STATE_DIR };
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_BRIDGE_HOME;
    else process.env.CODEX_BRIDGE_HOME = previousHome;
  }
}

function runGuard(root, bridgeHome, transcriptPath, reply) {
  return spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({
      session_id: SESSION_ID,
      agent_id: AGENT_ID,
      agent_type: 'codex-build',
      hook_event_name: 'SubagentStop',
      agent_transcript_path: transcriptPath,
      cwd: path.join(root, 'project'),
      last_assistant_message: reply,
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_BRIDGE_HOME: bridgeHome,
      CODEX_RUNS_ROOT: path.join(root, 'runs'),
      HOME: root,
      USERPROFILE: root,
    },
  });
}

function outputOf(result) {
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout ? JSON.parse(result.stdout) : null;
}

test('a delivered handback yields after the runner has completed', async () => {
  await withTempTree('bridge-guard-handback-answered-', async (root) => {
    const { bridgeHome, stateDir } = await stateDirsFor(root);
    const uses = [
      { id: 'runner-call', name: 'Bash' },
      { id: 'handback-call', name: HANDBACK_TOOL },
    ];
    const transcriptPath = await writeTranscript(root, uses);
    await writeState(stateDir, {
      handbackAttempts: 1,
      handback: 'delivered',
      runnerOutput: 'RUN=finished',
      runnerFinal: true,
      seenToolUseIds: uses.map(({ id }) => id),
    });

    assert.equal(outputOf(runGuard(root, bridgeHome, transcriptPath, 'Runner completed.')), null);
  });
});

test('a refused handback later substituted as delivered yields without another block', async () => {
  await withTempTree('bridge-guard-handback-refused-', async (root) => {
    const { bridgeHome, stateDir } = await stateDirsFor(root);
    const uses = [{ id: 'handback-call', name: HANDBACK_TOOL }];
    const transcriptPath = await writeTranscript(root, uses);
    await writeState(stateDir, {
      handbackAttempts: 1,
      handback: 'delivered',
      seenToolUseIds: ['handback-call'],
    });

    assert.equal(outputOf(runGuard(root, bridgeHome, transcriptPath, 'I did not delegate.')), null);
  });
});

test('interactive text is ignored once a later handback is delivered', async () => {
  await withTempTree('bridge-guard-handback-interactive-', async (root) => {
    const { bridgeHome, stateDir } = await stateDirsFor(root);
    const uses = [{ id: 'handback-call', name: HANDBACK_TOOL }];
    const transcriptPath = await writeTranscript(root, uses);
    await writeState(stateDir, {
      handbackAttempts: 1,
      handback: 'delivered',
      seenToolUseIds: ['handback-call'],
    });

    assert.equal(outputOf(runGuard(root, bridgeHome, transcriptPath, 'Earlier interactive text.')), null);
  });
});

test('a session without a handback attempt still uses the old missing RUN check', async () => {
  await withTempTree('bridge-guard-handback-legacy-', async (root) => {
    const { bridgeHome, stateDir } = await stateDirsFor(root);
    const transcriptPath = await writeTranscript(root);
    const output = outputOf(runGuard(root, bridgeHome, transcriptPath, 'Completed the task.'));

    assert.equal(output.decision, 'block');
    assert.equal(output.reason, missingRunReason);
  });
});

test('an undelivered handback is demanded once and the second stop passes', async () => {
  await withTempTree('bridge-guard-handback-demand-', async (root) => {
    const { bridgeHome, stateDir } = await stateDirsFor(root);
    const uses = [{ id: 'handback-call', name: HANDBACK_TOOL }];
    const transcriptPath = await writeTranscript(root, uses);
    await writeState(stateDir, { handbackAttempts: 1, seenToolUseIds: ['handback-call'] });

    const first = outputOf(runGuard(root, bridgeHome, transcriptPath, 'The answer is ready.'));
    assert.equal(first.decision, 'block');
    assert.equal(first.reason, handbackDemandReason);
    assert.equal(readDispatcherState({ stateDir, sessionId: SESSION_ID, agentId: AGENT_ID }).stopDemanded, true);

    assert.equal(outputOf(runGuard(root, bridgeHome, transcriptPath, 'The answer is ready.')), null);
  });
});

test('an unreceipted tool call alarms once, while complete receipts stay silent', async () => {
  await withTempTree('bridge-guard-handback-audit-', async (root) => {
    const { bridgeHome, stateDir } = await stateDirsFor(root);
    const uses = [
      { id: 'outside-call', name: 'Bash' },
      { id: 'handback-call', name: HANDBACK_TOOL },
    ];
    const transcriptPath = await writeTranscript(root, uses);
    await writeState(stateDir, {
      handbackAttempts: 1,
      handback: 'delivered',
      seenToolUseIds: ['handback-call'],
    });

    const first = outputOf(runGuard(root, bridgeHome, transcriptPath, 'Delivered answer.'));
    assert.match(first.systemMessage, /used Bash outside the dispatcher gate/);
    assert.equal(readHandbackWitness({ stateDir }).alarms.length, 1);
    assert.equal(readDispatcherState({ stateDir, sessionId: SESSION_ID, agentId: AGENT_ID }).auditAlarmed, true);

    assert.equal(outputOf(runGuard(root, bridgeHome, transcriptPath, 'Delivered answer.')), null);
    assert.equal(readHandbackWitness({ stateDir }).alarms.length, 1);

    await withTempTree('bridge-guard-handback-receipts-', async (completeRoot) => {
      const { bridgeHome: completeBridgeHome, stateDir: completeStateDir } = await stateDirsFor(completeRoot);
      const completeTranscriptPath = await writeTranscript(completeRoot, uses);
      await writeState(completeStateDir, {
        handbackAttempts: 1,
        handback: 'delivered',
        seenToolUseIds: uses.map(({ id }) => id),
      });
      assert.equal(outputOf(runGuard(completeRoot, completeBridgeHome, completeTranscriptPath, 'Delivered answer.')), null);
      assert.equal(readHandbackWitness({ stateDir: completeStateDir }).alarms.length, 0);
    });
  });
});
