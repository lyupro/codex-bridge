/** OW-074: capacity verdicts must participate in the reply guard's status check. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseReply } from '../../src/home/hooks/reply-parser.mjs';
import { statusMismatchReason } from '../../src/home/hooks/reply-verdicts.mjs';
import { updateDispatcherState } from '../../src/home/lib/dispatcher-state.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

const GUARD = fileURLToPath(new URL('../../src/home/hooks/reply-guard.mjs', import.meta.url));
const ACTION = 'Action: retry once; a second CAPACITY goes to the next executor';

function capacityReply(runDir) {
  return `ATTACH=${runDir}\nCAPACITY — selected model is at capacity; work not completed\n`
    + `Signal: selected model is at capacity\n${ACTION}\nLog: ${runDir}`;
}

async function fixture(t, status) {
  const root = makeTempTree('bridge-reply-guard-capacity-');
  t.after(() => removeTempTree(root));
  const repo = path.join(root, 'project');
  const runs = path.join(root, 'runs', 'project');
  const runDir = path.join(runs, 'capacity-check');
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runs, '.project.json'), `${JSON.stringify({ repo })}\n`);
  await fs.writeFile(path.join(runDir, 'status.json'), `${JSON.stringify({
    state: 'finished',
    pid: process.pid,
    agent: 'codex-build',
    slug: 'capacity-check',
    repo,
    started_at: new Date().toISOString(),
    process_started_at: performance.timeOrigin,
  })}\n`);
  const meta = { status, reason: 'measured runner verdict' };
  await fs.writeFile(path.join(runDir, 'meta.json'), `${JSON.stringify(meta)}\n`);

  const bridgeHome = path.join(root, '.lyupro', '.codex-bridge');
  const previousHome = process.env.CODEX_BRIDGE_HOME;
  process.env.CODEX_BRIDGE_HOME = bridgeHome;
  const moduleUrl = new URL('../../src/home/lib/brand-home.mjs', import.meta.url);
  moduleUrl.searchParams.set('test-home', bridgeHome);
  let stateDir;
  try {
    ({ BRAND_STATE_DIR: stateDir } = await import(moduleUrl.href));
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_BRIDGE_HOME;
    else process.env.CODEX_BRIDGE_HOME = previousHome;
  }
  const agentId = 'test-reply-guard-capacity';
  const sessionId = 'capacity-session';
  await updateDispatcherState({ stateDir, sessionId, agentId }, (current) => ({
    ...current, runReceipt: runDir,
  }));

  return { root, repo, runDir, meta, bridgeHome, agentId, sessionId };
}

function runGuard(fixture, reply) {
  const { root, repo, bridgeHome, agentId, sessionId } = fixture;
  return spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({
      agent_type: 'codex-build',
      agent_id: agentId,
      session_id: sessionId,
      cwd: repo,
      last_assistant_message: reply,
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_RUNS_ROOT: path.join(root, 'runs'),
      HOME: root,
      USERPROFILE: root,
      CODEX_BRIDGE_HOME: bridgeHome,
    },
  });
}

test('a full capacity reply after ATTACH claims CAPACITY', () => {
  const runDir = path.resolve('capacity-run');
  const parsed = parseReply(capacityReply(runDir));
  assert.equal(parsed.claimed, 'CAPACITY');
  assert.deepEqual(parsed.runDirs, [runDir]);
});

test('CAPACITY inside an Action row does not claim a verdict', () => {
  assert.equal(parseReply(ACTION).claimed, undefined);
});

test('claiming CAPACITY for a FAIL run blocks with the existing mismatch reason', async (t) => {
  const context = await fixture(t, 'FAIL');
  const result = runGuard(context, capacityReply(context.runDir));
  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.decision, 'block');
  assert.equal(decision.reason, statusMismatchReason('CAPACITY', context.meta, null, context.runDir));
});

test('claiming CAPACITY for a CAPACITY run passes without a status mismatch', async (t) => {
  const context = await fixture(t, 'CAPACITY');
  const result = runGuard(context, capacityReply(context.runDir));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});
