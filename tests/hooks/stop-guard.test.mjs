/** Verifies the Plan_31 TaskStop guard and its fail-open boundaries. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HEARTBEAT_FILE } from '../../src/heartbeat.mjs';
import { STOP_REASON, renderStopCommand } from '../../src/stop-contract.mjs';
import { STOP_TOOLS } from '../../src/hook-definitions.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const GUARD = path.join(ROOT, 'src', 'hooks', 'stop-guard.mjs');
const REPOSITORY = path.resolve('stop-guard-repository');

function request(toolName = STOP_TOOLS[0], taskId = 'host-task') {
  return {
    tool_name: toolName,
    tool_input: { task_id: taskId },
    cwd: REPOSITORY,
    session_id: 'host-session',
  };
}

function runGuard(root, input) {
  return spawnSync(process.execPath, [GUARD], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_RUNS_ROOT: path.join(root, 'runs'),
      HOME: root,
      USERPROFILE: root,
    },
  });
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-stop-guard-'));
  const runs = path.join(root, 'runs', 'project');
  await fs.mkdir(runs, { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, runs };
}

async function createLiveRun(runs, name) {
  const dir = path.join(runs, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'status.json'), `${JSON.stringify({
    state: 'running',
    pid: process.pid,
    agent: 'codex-build',
    slug: 'stop-guard-test',
    repo: REPOSITORY,
  })}\n`);
  await fs.writeFile(path.join(dir, HEARTBEAT_FILE), 'progress\n');
  return dir;
}

test('denies the first stop of a confirmed live run with the ready command', async (t) => {
  const { root, runs } = await fixture(t);
  const dir = await createLiveRun(runs, 'active-run');

  const result = runGuard(root, request());
  assert.equal(result.status, 0);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /active-run/);
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, new RegExp(renderStopCommand('active-run')));
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, new RegExp(STOP_REASON.replace('.', '\\.')));
  assert.equal(dir.endsWith('active-run'), true);
});

test('passes the second consecutive stop for the same run folder', async (t) => {
  const { root, runs } = await fixture(t);
  await createLiveRun(runs, 'active-run');

  assert.equal(runGuard(root, request(STOP_TOOLS[0], 'first-task')).stdout.includes('permissionDecision'), true);
  const second = runGuard(root, request(STOP_TOOLS[0], 'different-host-task'));
  assert.equal(second.status, 0);
  assert.equal(second.stdout, '');
});

test('passes silently when no confirmed live run matches the cwd', async (t) => {
  const { root } = await fixture(t);
  const result = runGuard(root, request());
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('passes silently for a foreign tool name', async (t) => {
  const { root, runs } = await fixture(t);
  await createLiveRun(runs, 'active-run');
  const result = runGuard(root, request('Bash'));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('fails open on an unparsable payload', async (t) => {
  const { root, runs } = await fixture(t);
  await createLiveRun(runs, 'active-run');
  const result = runGuard(root, '{not-json');
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});
