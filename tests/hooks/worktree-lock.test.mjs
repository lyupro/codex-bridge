/** Verifies the PreToolUse lock for every supported Claude Code file-writing tool. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  HOOK_DEFINITIONS,
  WRITE_TOOL_MATCHER,
  WRITE_TOOLS,
} from '../../src/hook-definitions.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const LOCK = path.join(ROOT, 'src', 'hooks', 'worktree-lock.mjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-worktree-lock-'));
  const runsRoot = path.join(root, 'runs');
  await fs.mkdir(runsRoot, { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, runsRoot };
}

async function liveRun(runsRoot, { agent = 'codex-build', repo, state = 'running', pid = process.pid } = {}) {
  const dir = path.join(runsRoot, 'project', '2026-08-05_run');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'status.json'), `${JSON.stringify({
    state,
    pid,
    agent,
    slug: 'lock-test-run',
    repo,
    started_at: '2026-08-05T10:00:00.000Z',
  })}\n`);
  return dir;
}

function runLock(root, runsRoot, toolName, rawPath, cwd = root) {
  const pathField = toolName === 'NotebookEdit' ? 'notebook_path' : 'file_path';
  return spawnSync(process.execPath, [LOCK], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: toolName,
      tool_input: { [pathField]: rawPath },
      cwd,
    }),
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_RUNS_ROOT: runsRoot,
      HOME: root,
      USERPROFILE: root,
    },
  });
}

function assertPass(result) {
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
}

test('the registry matcher covers every write tool the lock answers to', () => {
  const definition = HOOK_DEFINITIONS.find((entry) => entry.file === 'worktree-lock.mjs');
  assert.equal(definition.matcher, WRITE_TOOL_MATCHER);
  const matcher = new RegExp(`^(?:${definition.matcher})$`);
  for (const toolName of WRITE_TOOLS) assert.ok(matcher.test(toolName), toolName);
});

test('the lock denies writes inside a live codex-build repository for every write tool', async (t) => {
  const { root, runsRoot } = await fixture(t);
  const repo = path.join(root, 'repository');
  await liveRun(runsRoot, { repo });
  for (const toolName of WRITE_TOOLS) {
    const target = path.join(repo, `${toolName}.txt`);
    const result = runLock(root, runsRoot, toolName, target);
    assert.equal(result.status, 0, toolName);
    const decision = JSON.parse(result.stdout).hookSpecificOutput;
    assert.equal(decision.permissionDecision, 'deny', toolName);
    assert.match(decision.permissionDecisionReason, /codex-build/);
    assert.match(decision.permissionDecisionReason, /lock-test-run/);
    assert.match(decision.permissionDecisionReason, /repository/);
  }
});

// The run this hook denies for is always a working one — a stale heartbeat is not live here, so
// the edit would pass instead. The wording has to say that, or an operator reading "silent" beside
// a stop command kills a healthy run.
test('the denial reports last progress and the exact release command', async (t) => {
  const { root, runsRoot } = await fixture(t);
  const repo = path.join(root, 'repository');
  const runDir = await liveRun(runsRoot, { repo });
  const heartbeat = path.join(runDir, 'heartbeat');
  await fs.writeFile(heartbeat, 'progress\n');
  const staleAt = new Date(Date.now() - 7000);
  await fs.utimes(heartbeat, staleAt, staleAt);

  const result = runLock(root, runsRoot, 'Write', path.join(repo, 'file.txt'));
  const reason = JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /It is working; last progress \d+ seconds ago/);
  assert.match(reason, new RegExp(`codex-bridge stop ${path.basename(runDir)}`));
  assert.doesNotMatch(reason, /Wait for status\.json/);
  assert.doesNotMatch(reason, /silent for/);
});

test('the lock allows writes when no run is live', async (t) => {
  const { root, runsRoot } = await fixture(t);
  const repo = path.join(root, 'repository');
  await liveRun(runsRoot, { repo, state: 'finished' });
  assertPass(runLock(root, runsRoot, 'Write', path.join(repo, 'file.txt')));
});

test('the lock allows live scout and review runs', async (t) => {
  for (const agent of ['codex-scout', 'codex-review']) {
    const { root, runsRoot } = await fixture(t);
    const repo = path.join(root, 'repository');
    await liveRun(runsRoot, { repo, agent });
    assertPass(runLock(root, runsRoot, 'Edit', path.join(repo, 'file.txt')));
  }
});

test('the lock allows a write outside the live build repository', async (t) => {
  const { root, runsRoot } = await fixture(t);
  const repo = path.join(root, 'repository');
  await liveRun(runsRoot, { repo });
  assertPass(runLock(root, runsRoot, 'Write', path.join(root, 'other-repository', 'file.txt')));
});

test('Windows-shaped repository and target paths compare case-insensitively without realpath', async (t) => {
  const { root, runsRoot } = await fixture(t);
  const repo = path.join(root, 'Repository');
  const repositoryInStatus = `${repo.toUpperCase()}\\`;
  await liveRun(runsRoot, { repo: repositoryInStatus });
  const target = path.join(repo, 'src', 'file.mjs').toLowerCase().replaceAll('/', '\\');
  const result = runLock(root, runsRoot, 'Edit', target);
  const decision = JSON.parse(result.stdout).hookSpecificOutput;
  assert.equal(decision.permissionDecision, 'deny');
});

test('relative paths use the host cwd and malformed payloads pass', async (t) => {
  const { root, runsRoot } = await fixture(t);
  const repo = path.join(root, 'repository');
  await liveRun(runsRoot, { repo });
  const relative = runLock(root, runsRoot, 'Write', 'nested/file.txt', repo);
  assert.equal(JSON.parse(relative.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const malformed = spawnSync(process.execPath, [LOCK], {
    input: '{',
    encoding: 'utf8',
    env: { ...process.env, CODEX_RUNS_ROOT: runsRoot, HOME: root, USERPROFILE: root },
  });
  assertPass(malformed);
});
