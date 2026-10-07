import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { readHandbackWitness, witnessKey } from '../../src/home/lib/handback-witness.mjs';
import { entryState } from '../../src/home/lib/observation-ledger.mjs';
import { updateDispatcherState } from '../../src/home/lib/dispatcher-state.mjs';
import { withTempTree } from '../temp-tree.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const GUARD = path.join(ROOT, 'src', 'home', 'hooks', 'reply-guard.mjs');
const MESSAGE = 'codex-bridge: the host did not report agent_type for a subagent — the dispatcher gate cannot recognise dispatchers, so their answers are unchecked; run codex-bridge doctor.';

function runGuard(root, payload) {
  const bridgeHome = path.join(root, 'bridge-home');
  const result = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_BRIDGE_HOME: bridgeHome,
      HOME: root,
      USERPROFILE: root,
    },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return { ...result, stateDir: path.join(bridgeHome, 'state') };
}

async function assertAlarm(root, payload, agentId) {
  const result = runGuard(root, payload);
  assert.deepEqual(JSON.parse(result.stdout), { systemMessage: MESSAGE });
  const witness = readHandbackWitness({ stateDir: result.stateDir });
  const entry = witness.ledger.entries[witnessKey({ cause: 'missing-agent-type', hostVersion: null })];
  assert.equal(Object.keys(witness.ledger.entries).length, 1);
  assert.equal(entryState(entry), 'violation');
  assert.equal(entry.lastViolation.data.hostVersion, null);
  assert.equal(entry.lastViolation.detail, `host omitted agent_type for agent ${agentId}; evidence: gate-state`);
}

test('missing agent_type without dispatcher evidence is undetermined and silent', async () => {
  await withTempTree('bridge-guard-agent-type-missing-', async (root) => {
    const result = runGuard(root, { agent_id: 'missing-type-agent' });
    assert.equal(result.stdout, '');
    const witness = readHandbackWitness({ stateDir: result.stateDir });
    const key = witnessKey({ cause: 'missing-agent-type', hostVersion: null });
    const entry = witness.ledger.entries[key];
    assert.equal(entryState(entry), 'undetermined');
    assert.equal(entry.lastViolation, null);
    assert.equal(entry.lastMatch, null);
    assert.equal(entry.lastObservation.detail,
      'untyped subagent stop without dispatcher evidence (transcript-unreadable)');
  });
});

for (const agentType of [undefined, '']) {
  test(`${agentType === '' ? 'empty' : 'missing'} agent_type with gate-state evidence alarms and warns`, async () => {
    await withTempTree('bridge-guard-agent-type-evidence-', async (root) => {
      const agentId = 'untyped-dispatcher';
      const sessionId = 'dispatcher-session';
      await updateDispatcherState({
        stateDir: path.join(root, 'bridge-home', 'state'), sessionId, agentId,
      }, () => ({ agentType: 'codex-build', seenToolUseIds: ['runner-call'] }));
      await assertAlarm(root, { agent_id: agentId, session_id: sessionId, agent_type: agentType }, agentId);
    });
  });
}

test('a readable untyped transcript without dispatcher tools stays silent', async () => {
  await withTempTree('bridge-guard-agent-type-readable-', async (root) => {
    const transcriptPath = path.join(root, 'agent.jsonl');
    await fs.writeFile(transcriptPath, JSON.stringify({ type: 'assistant', message: { content: [] } }));
    const result = runGuard(root, { agent_id: 'ordinary-agent', agent_transcript_path: transcriptPath });
    assert.equal(result.stdout, '');
    const entry = readHandbackWitness({ stateDir: result.stateDir }).ledger.entries[
      witnessKey({ cause: 'missing-agent-type', hostVersion: null })
    ];
    assert.equal(entryState(entry), 'undetermined');
    assert.equal(entry.lastObservation.detail, 'untyped subagent stop without dispatcher evidence (no-evidence)');
  });
});

test('a main session without agent identity stays silent', async () => {
  await withTempTree('bridge-guard-agent-type-main-', async (root) => {
    const result = runGuard(root, {});
    assert.equal(result.stdout, '');
    await assert.rejects(fs.access(path.join(result.stateDir, 'handback-witness.json')));
  });
});

test('a named subagent stays silent and records no alarm', async () => {
  await withTempTree('bridge-guard-agent-type-present-', async (root) => {
    const result = runGuard(root, { agent_id: 'named-agent', agent_type: 'Explore' });
    assert.equal(result.stdout, '');
    await assert.rejects(fs.access(path.join(result.stateDir, 'handback-witness.json')));
  });
});
