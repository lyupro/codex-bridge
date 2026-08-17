/** Verifies definition-owned hook dispatch, unchanged stdin, and actionable argument failures. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HOOK_DEFINITIONS } from '../../src/home/lib/hook-definitions.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const BIN = path.join(ROOT, 'bin', 'codex-bridge.mjs');

function run(args, input, env = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    input,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

async function fixture(t, prefix = 'bridge-hook-') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function liveRun(root, repo, name = 'active-run') {
  const runsRoot = path.join(root, 'runs');
  const dir = path.join(runsRoot, 'project', name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'status.json'), `${JSON.stringify({
    state: 'running',
    pid: process.pid,
    agent: 'codex-build',
    slug: 'hook-dispatch-test',
    repo,
    process_started_at: performance.timeOrigin,
  })}\n`);
  await fs.writeFile(path.join(dir, 'heartbeat'), 'progress\n');
  return runsRoot;
}

function hookEnvironment(root, runsRoot = path.join(root, 'runs')) {
  return {
    HOME: root,
    USERPROFILE: root,
    CODEX_RUNS_ROOT: runsRoot,
  };
}

test('every definition name reaches its existing top-level guard', async (t) => {
  for (const definition of HOOK_DEFINITIONS) {
    const root = await fixture(t, `bridge-hook-${definition.name}-`);
    const env = hookEnvironment(root);
    if (definition.file === 'reply-guard.mjs') {
      const input = { agent_type: 'not-a-codex-dispatcher', marker: 'reply-probe' };
      const result = run(['hook', definition.name], JSON.stringify(input), env);
      assert.equal(result.status, 0, definition.name);
      const saved = JSON.parse(await fs.readFile(
        path.join(root, '.claude', 'logs', 'codex-reply-guard.last.json'),
        'utf8',
      ));
      assert.deepEqual(saved, input, definition.name);
      continue;
    }
    if (definition.file === 'order-gate.mjs') {
      const input = {
        hook_event_name: 'PreToolUse',
        tool_name: 'Agent',
        tool_input: { subagent_type: 'codex-build', prompt: '' },
        marker: 'order-probe',
      };
      const result = run(['hook', definition.name], JSON.stringify(input), env);
      assert.equal(result.status, 0, definition.name);
      assert.match(result.stdout, /Order gate denied/, definition.name);
      continue;
    }
    if (definition.file === 'worktree-lock.mjs') {
      const repo = path.join(root, 'repository');
      const runsRoot = await liveRun(root, repo);
      const result = run(['hook', definition.name], JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: path.join(repo, 'file.txt') },
        cwd: repo,
      }), hookEnvironment(root, runsRoot));
      assert.equal(result.status, 0, definition.name);
      assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
      continue;
    }
    if (definition.file === 'worktree-witness.mjs') {
      // PostToolUse arrives after the work is done, so this guard reports instead of denying:
      // the branch below reproduces the 2026-08-16 incident — a live run scoped to src/** while
      // the orchestrator changed CHANGELOG.md through a shell heredoc.
      const repo = path.join(root, 'repository');
      await fs.mkdir(repo, { recursive: true });
      assert.equal(spawnSync('git', ['init', '-q', repo]).status, 0, definition.name);
      const runsRoot = await liveRun(root, repo);
      const dir = path.join(runsRoot, 'project', 'active-run');
      await fs.writeFile(path.join(dir, 'git-before.txt'), '');
      await fs.writeFile(path.join(dir, 'scope.txt'), 'src/**\n');
      await fs.writeFile(path.join(repo, 'CHANGELOG.md'), 'changed by another hand\n');
      const result = run(['hook', definition.name], JSON.stringify({
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'python - <<PY' },
        cwd: repo,
      }), hookEnvironment(root, runsRoot));
      assert.equal(result.status, 0, definition.name);
      assert.match(
        JSON.parse(result.stdout).hookSpecificOutput.additionalContext,
        /CHANGELOG\.md/,
        definition.name,
      );
      continue;
    }
    if (definition.file === 'prune-guard.mjs') {
      const result = run(['hook', definition.name], JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'codex-bridge prune project -f' },
      }), env);
      assert.equal(result.status, 0, definition.name);
      assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
      continue;
    }
    const repo = path.join(root, 'repository');
    const runsRoot = await liveRun(root, repo);
    const result = run(['hook', definition.name], JSON.stringify({
      tool_name: 'TaskStop',
      tool_input: { task_id: 'host-task' },
      cwd: repo,
    }), hookEnvironment(root, runsRoot));
    assert.equal(result.status, 0, definition.name);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
  }
});

test('stdin and the guard exit status pass through the CLI unchanged', async (t) => {
  const root = await fixture(t);
  const input = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Agent',
    tool_input: { subagent_type: 'codex-build', prompt: '' },
    marker: 'preserve-this-payload',
  });
  const env = hookEnvironment(root);
  const guard = path.join(ROOT, 'src', 'home', 'hooks', 'order-gate.mjs');
  const direct = spawnSync(process.execPath, [guard], { input, encoding: 'utf8', env: { ...process.env, ...env } });
  const dispatched = run(['hook', 'order-gate'], input, env);
  assert.equal(dispatched.status, direct.status);
  assert.equal(dispatched.stdout, direct.stdout);
  assert.equal(dispatched.stderr, direct.stderr);
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(root, '.claude', 'logs', 'codex-order-gate.last.json'), 'utf8')),
    JSON.parse(input),
  );
});

test('unknown, missing, and extra names fail with exit 2 and list every valid name', () => {
  const names = HOOK_DEFINITIONS.map(({ name }) => name);
  const cases = [
    ['hook'],
    ['hook', 'not-a-hook'],
    ['hook', names[0], 'extra'],
  ];
  for (const args of cases) {
    const result = run(args, '');
    assert.equal(result.status, 2, args.join(' '));
    for (const name of names) assert.match(result.stderr, new RegExp(name), args.join(' '));
  }
});
