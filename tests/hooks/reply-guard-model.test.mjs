/** Plan_67 D4: observe before yield/demand and preserve the independent tool-audit alarm. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { claudePaths } from '../../src/home/lib/claude-layout.mjs';
import { DISPATCHER_MODEL_FILE, readDispatcherModel } from '../../src/home/lib/dispatcher-model.mjs';
import { updateDispatcherState } from '../../src/home/lib/dispatcher-state.mjs';
import { homeArtifact } from '../../src/home/lib/home-registry.mjs';
import { handbackDemandReason } from '../../src/home/hooks/reply-verdicts.mjs';
import { withTempTree } from '../temp-tree.mjs';

const GUARD = fileURLToPath(new URL('../../src/home/hooks/reply-guard.mjs', import.meta.url));
const agentType = 'codex-build';
const sessionId = 'model-test-session';
const agentId = 'model-test-dispatcher';
const alarm = 'codex-bridge: dispatcher codex-build ran on sonnet while the installed contract pins haiku — Claude quota was spent on it; run codex-bridge doctor.';

async function fixture(root, { model = 'claude-sonnet-4-5', state, toolUses = [] } = {}) {
  const brandRoot = path.join(root, 'bridge-home');
  const stateDir = path.join(brandRoot, 'state');
  const ownerRoot = path.join(root, 'owner', '.claude');
  const agentFile = path.join(claudePaths(ownerRoot).agentsDir, `${agentType}.md`);
  await fs.mkdir(path.dirname(agentFile), { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(agentFile, `---\nname: ${agentType}\nmodel: haiku\n---\nBody.\n`);
  await fs.writeFile(path.join(brandRoot, homeArtifact('install-record').primary[0]), JSON.stringify({
    format: 2, inventory: 'complete', owners: { test: { root: ownerRoot } },
  }));
  const transcriptPath = path.join(root, 'agent.jsonl');
  await fs.writeFile(transcriptPath, `${JSON.stringify({
    type: 'assistant', message: { model, content: toolUses },
  })}\n`);
  if (state) await updateDispatcherState({ stateDir, sessionId, agentId }, () => state);
  return { brandRoot, stateDir, transcriptPath, agentFile };
}

function runGuard(root, { brandRoot, transcriptPath }, overrides = {}) {
  const result = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({
      session_id: sessionId, agent_id: agentId, agent_type: agentType,
      hook_event_name: 'SubagentStop', agent_transcript_path: transcriptPath,
      cwd: root, last_assistant_message: 'Delivered answer.', ...overrides,
    }),
    encoding: 'utf8',
    env: {
      ...process.env, CODEX_BRIDGE_HOME: brandRoot, CODEX_RUNS_ROOT: path.join(root, 'runs'),
      HOME: root, USERPROFILE: root,
    },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout ? JSON.parse(result.stdout) : null;
}

function violationOf(stateDir) {
  const ledger = readDispatcherModel({ stateDir });
  assert.equal(ledger.seq, 1);
  const observation = ledger.entries[`unknown|${agentType}`].lastViolation;
  assert.equal(observation.verdict, 'violation');
  assert.deepEqual(observation.data.parsed, ['sonnet']);
  assert.equal(observation.data.pinFamily, 'haiku');
  assert.equal(observation.data.comparison, 'installed-contract');
  return observation;
}

test('foreign-family models are recorded before delivered handback yields, alongside the tool audit', async () => {
  await withTempTree('reply-guard-model-yield-', async (root) => {
    const dirs = await fixture(root, {
      state: { handback: 'delivered', seenToolUseIds: [] },
      toolUses: [{ type: 'tool_use', id: 'outside-call', name: 'Bash' }],
    });
    const output = runGuard(root, dirs);
    assert.deepEqual(Object.keys(output), ['systemMessage']);
    assert.equal(output.systemMessage, `${alarm} codex-bridge: dispatcher codex-build used Bash outside the dispatcher gate — do not trust its answer; run codex-bridge doctor.`);
    violationOf(dirs.stateDir);
  });
});

test('foreign-family observation precedes the handback demand without changing its decision', async () => {
  await withTempTree('reply-guard-model-demand-', async (root) => {
    const dirs = await fixture(root, { state: { handbackAttempts: 1, seenToolUseIds: [] } });
    assert.deepEqual(runGuard(root, dirs), { decision: 'block', reason: handbackDemandReason, systemMessage: alarm });
    violationOf(dirs.stateDir);
  });
});

test('model observation also runs without host ids before the legacy reply checks', async () => {
  await withTempTree('reply-guard-model-no-ids-', async (root) => {
    const dirs = await fixture(root);
    const output = runGuard(root, dirs, { session_id: null, agent_id: null });
    assert.deepEqual(output, { systemMessage: alarm });
    violationOf(dirs.stateDir);
  });
});

test('unregistered agents never create dispatcher model observations', async () => {
  await withTempTree('reply-guard-model-unregistered-', async (root) => {
    const dirs = await fixture(root);
    assert.equal(runGuard(root, dirs, { agent_type: 'unrelated-agent' }), null);
    assert.equal(readDispatcherModel({ stateDir: dirs.stateDir }).seq, 0);
  });
});

test('a corrupt model ledger fails open while still reporting the observed quota violation', async () => {
  await withTempTree('reply-guard-model-corrupt-', async (root) => {
    const dirs = await fixture(root, { state: { handback: 'delivered', seenToolUseIds: [] } });
    const file = path.join(dirs.stateDir, DISPATCHER_MODEL_FILE);
    await fs.writeFile(file, '{malformed');
    assert.deepEqual(runGuard(root, dirs), { systemMessage: alarm });
    assert.equal(await fs.readFile(file, 'utf8'), '{malformed');
  });
});

test('unparsed models and undetermined installed pins produce observations without accusations', async () => {
  for (const problem of ['unparsed-model', 'unreadable-transcript', 'undetermined-pin']) {
    await withTempTree('reply-guard-model-undetermined-', async (root) => {
      const dirs = await fixture(root, {
        model: problem === 'unparsed-model' ? '<synthetic>' : 'sonnet',
        state: { handback: 'delivered', seenToolUseIds: [] },
      });
      if (problem === 'undetermined-pin') {
        await fs.writeFile(dirs.agentFile, `---\nname: ${agentType}\nmodel: inherit\n---\n`);
      }
      if (problem === 'unreadable-transcript') dirs.transcriptPath = path.join(root, 'missing.jsonl');
      assert.equal(runGuard(root, dirs), null);
      const entry = readDispatcherModel({ stateDir: dirs.stateDir }).entries[`unknown|${agentType}`];
      assert.equal(entry.lastObservation.verdict, 'undetermined');
      assert.equal(entry.lastViolation, null);
      if (problem === 'undetermined-pin') assert.equal(entry.lastObservation.data.pinReasons.length, 1);
    });
  }
});

test('a matching family yields without a model alarm and records a confirmed match', async () => {
  await withTempTree('reply-guard-model-match-', async (root) => {
    const dirs = await fixture(root, { model: 'haiku', state: { handback: 'delivered', seenToolUseIds: [] } });
    assert.equal(runGuard(root, dirs), null);
    const entry = readDispatcherModel({ stateDir: dirs.stateDir }).entries[`unknown|${agentType}`];
    assert.equal(entry.lastMatch.verdict, 'match');
    assert.equal(entry.lastViolation, null);
  });
});
