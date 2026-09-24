/** Verifies definition-owned hook dispatch, unchanged stdin, and actionable argument failures. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HOOK_DEFINITIONS } from '../../src/home/lib/hook-definitions.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const BIN = path.join(ROOT, 'bin', 'codex-bridge.mjs');

function run(args, input, env = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    input,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...env },
  });
}

async function fixture(t, prefix = 'bridge-hook-') {
  const root = makeTempTree(prefix);
  t.after(() => removeTempTree(root));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: '@lyupro/codex-bridge', version: '0.6.6' }));
  await fs.cp(path.join(ROOT, 'src', 'home'), path.join(root, '.lyupro', '.codex-bridge'), { recursive: true });
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
    CODEX_BRIDGE_HOME: path.join(root, '.lyupro', '.codex-bridge'),
  };
}

test('every definition name reaches its existing top-level guard', async (t) => {
  for (const definition of HOOK_DEFINITIONS) {
    const root = await fixture(t, `bridge-hook-${definition.name}-`);
    const env = hookEnvironment(root);
    if (definition.file === 'reply-guard.mjs') {
      const input = { agent_type: 'not-a-codex-dispatcher', marker: 'reply-probe' };
      const result = run(['hook', definition.name], JSON.stringify(input), env);
      assert.equal(result.status, 0, `${definition.name}: ${result.stderr}`);
      const saved = JSON.parse(await fs.readFile(
        path.join(root, '.lyupro', '.codex-bridge', 'state', 'diagnostics', 'reply-guard.last.json'),
        'utf8',
      ));
      assert.deepEqual(saved, input, definition.name);
      await assert.rejects(fs.access(path.join(root, '.claude', 'logs')), { code: 'ENOENT' });
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
      const saved = JSON.parse(await fs.readFile(path.join(
        root, '.lyupro', '.codex-bridge', 'state', 'diagnostics', 'order-gate.last.json',
      ), 'utf8'));
      assert.deepEqual(saved, input, definition.name);
      await assert.rejects(fs.access(path.join(root, '.claude', 'logs')), { code: 'ENOENT' });
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
      // The baseline the witness reads is the verdict's snapshot, not porcelain: since Plan_58 both
      // judge the tree with one instrument, and a fixture writing git-before.txt only proved that
      // the hook fails open.
      await fs.writeFile(path.join(dir, 'state-before.txt'), '');
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
    if (definition.file === 'dispatcher-gate.mjs') {
      const input = {
        agent_type: 'codex-build',
        hook_event_name: definition.event,
        session_id: `session-${definition.name}`,
        agent_id: `agent-${definition.name}`,
        tool_use_id: `tool-${definition.name}`,
        tool_name: 'Bash',
        tool_input: { command: 'cat C:/abs/task.md' },
      };
      await fs.cp(path.join(ROOT, 'src', 'home'), root, { recursive: true });
      const result = run(['hook', definition.name], JSON.stringify(input), {
        ...env,
        CODEX_BRIDGE_HOME: root,
      });
      assert.equal(result.status, 0, definition.name);
      if (definition.event === 'PreToolUse') {
        assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
      } else {
        assert.equal(result.stdout, '');
      }
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
  assert.equal(dispatched.status, direct.status, dispatched.stderr);
  assert.equal(dispatched.stdout, direct.stdout);
  assert.equal(dispatched.stderr, direct.stderr);
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(
      root, '.lyupro', '.codex-bridge', 'state', 'diagnostics', 'order-gate.last.json',
    ), 'utf8')),
    JSON.parse(input),
  );
  await assert.rejects(fs.access(path.join(root, '.claude', 'logs')), { code: 'ENOENT' });
});

test('unknown, missing, and extra names fail with exit 1', async (t) => {
  const names = HOOK_DEFINITIONS.map(({ name }) => name);
  const root = await fixture(t);
  const env = { CODEX_BRIDGE_HOME: path.join(root, '.lyupro', '.codex-bridge') };
  const cases = [
    ['hook'],
    ['hook', 'not-a-hook'],
    ['hook', names[0], 'extra'],
  ];
  for (const args of cases) {
    const result = run(args, '', env);
    assert.equal(result.status, 1, args.join(' '));
    if (args.length === 2) assert.match(result.stderr, /unknown hook name/, args.join(' '));
    else assert.match(result.stderr, /Usage: codex-bridge hook/, args.join(' '));
  }
});
