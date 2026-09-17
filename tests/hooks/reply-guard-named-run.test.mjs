/**
 * Plan_57 D27: the named run must use shared liveness judgment so the bare-pid defect
 * cannot mistake a foreign process reusing the worker's pid for a run still in progress.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const GUARD = path.join(ROOT, 'src', 'home', 'hooks', 'reply-guard.mjs');

function runGuard(root, reply, agentId = 'test-reply-guard', transcriptPath = undefined) {
  const repo = path.join(root, 'project');
  return spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({
      agent_type: 'codex-build',
      agent_id: agentId,
      agent_transcript_path: transcriptPath,
      cwd: repo,
      last_assistant_message: reply,
    }),
    encoding: 'utf8',
    env: { ...process.env, CODEX_RUNS_ROOT: path.join(root, 'runs'), HOME: root, USERPROFILE: root },
  });
}

async function fixture(t) {
  const root = makeTempTree('bridge-reply-guard-');
  const runs = path.join(root, 'runs', 'project');
  await fs.mkdir(runs, { recursive: true });
  await fs.writeFile(path.join(runs, '.project.json'), `${JSON.stringify({ repo: path.join(root, 'project') })}\n`);
  t.after(() => removeTempTree(root));
  return { root, runs };
}

async function createRun(runs, name, status, meta = null) {
  const dir = path.join(runs, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'status.json'), `${JSON.stringify(status)}\n`);
  if (meta) await fs.writeFile(path.join(dir, 'meta.json'), `${JSON.stringify(meta)}\n`);
  return dir;
}

function replyFor(runDir, extra = '') {
  return `RUN=${runDir}\nOK — run finished.${extra}`;
}

test('blocks the named run as dead when its pid belongs to a foreign process', async (t) => {
  const { root, runs } = await fixture(t);
  const runDir = await createRun(runs, 'foreign-pid', {
    state: 'running',
    pid: process.pid,
    agent: 'codex-build',
    slug: 'foreign-pid',
    repo: path.join(root, 'project'),
    started_at: '2020-01-01T00:00:00.000Z',
    process_started_at: Date.parse('2020-01-01T00:00:00.000Z'),
  });

  // On the old code this exact fixture produced the live-run block.
  const result = runGuard(root, replyFor(runDir));
  assert.equal(result.status, 0);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.decision, 'block');
  assert.match(decision.reason, /process with this pid is dead/);
  assert.doesNotMatch(decision.reason, /the process is alive/);
});

test('blocks the named run as dead when its pid is gone and meta is missing', async (t) => {
  const { root, runs } = await fixture(t);
  const runDir = await createRun(runs, 'dead-pid', {
    state: 'running',
    pid: Number.MAX_SAFE_INTEGER,
    agent: 'codex-build',
    slug: 'dead-pid',
    repo: path.join(root, 'project'),
  });

  const result = runGuard(root, replyFor(runDir));
  assert.equal(result.status, 0);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.decision, 'block');
  assert.match(decision.reason, /process with this pid is dead/);
  assert.doesNotMatch(decision.reason, /the process is alive/);
});

test('blocks the named run as live when process identity matches and heartbeat is fresh', async (t) => {
  const { root, runs } = await fixture(t);
  const runDir = await createRun(runs, 'live-pid', {
    state: 'running',
    pid: process.pid,
    agent: 'codex-build',
    slug: 'live-pid',
    repo: path.join(root, 'project'),
    started_at: new Date(performance.timeOrigin).toISOString(),
    process_started_at: performance.timeOrigin,
  });
  await fs.writeFile(path.join(runDir, 'heartbeat'), `${Date.now()}\n`);

  const result = runGuard(root, replyFor(runDir));
  assert.equal(result.status, 0);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.decision, 'block');
  assert.match(decision.reason, /the process is alive/);
});
