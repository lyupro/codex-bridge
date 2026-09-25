import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
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
  const witness = JSON.parse(await fs.readFile(path.join(result.stateDir, 'handback-witness.json'), 'utf8'));
  assert.equal(witness.alarms.length, 1);
  assert.equal(witness.alarms[0].detail, `host omitted agent_type for agent ${agentId}`);
}

test('missing agent_type on a subagent alarms and warns', async () => {
  await withTempTree('bridge-guard-agent-type-missing-', async (root) => {
    await assertAlarm(root, { agent_id: 'missing-type-agent' }, 'missing-type-agent');
  });
});

test('empty agent_type on a subagent alarms and warns', async () => {
  await withTempTree('bridge-guard-agent-type-empty-', async (root) => {
    await assertAlarm(root, { agent_id: 'empty-type-agent', agent_type: '' }, 'empty-type-agent');
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
