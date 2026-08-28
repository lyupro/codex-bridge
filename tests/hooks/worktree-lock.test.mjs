/** Verifies the PreToolUse lock for every supported Claude Code file-writing tool. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  HOOK_DEFINITIONS,
  LOCKED_TOOL_MATCHER,
  SHELL_TOOLS,
  WRITE_TOOLS,
} from '../../src/home/lib/hook-definitions.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const LOCK = path.join(ROOT, 'src', 'home', 'hooks', 'worktree-lock.mjs');

async function fixture(t) {
  const root = makeTempTree('bridge-worktree-lock-');
  const runsRoot = path.join(root, 'runs');
  await fs.mkdir(runsRoot, { recursive: true });
  t.after(() => removeTempTree(root));
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
    process_started_at: performance.timeOrigin,
  })}\n`);
  return dir;
}

async function initializeRepository(repo) {
  await fs.mkdir(repo, { recursive: true });
  const result = spawnSync('git', ['init', '--quiet', repo], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function runLock(root, runsRoot, toolName, rawPath, cwd = root, env = {}) {
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
      ...env,
    },
  });
}

function runShell(root, runsRoot, command, cwd = root) {
  return spawnSync(process.execPath, [LOCK], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command },
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

test('one registration routes every tool the lock answers to, write and shell alike', () => {
  // Two entries naming worktree-lock.mjs put the same file twice into the installation record,
  // which forbids duplicates — 33 tests failed on it on 2026-08-17. One entry, one wide matcher.
  const entries = HOOK_DEFINITIONS.filter((entry) => entry.file === 'worktree-lock.mjs');
  assert.equal(entries.length, 1);
  const [definition] = entries;
  assert.equal(definition.name, 'worktree-lock');
  assert.equal(definition.matcher, LOCKED_TOOL_MATCHER);
  const matcher = new RegExp(`^(?:${definition.matcher})$`);
  for (const toolName of [...WRITE_TOOLS, ...SHELL_TOOLS]) assert.ok(matcher.test(toolName), toolName);
});

test('the lock denies writes inside a live codex-build repository for every write tool', async (t) => {
  const { root, runsRoot } = await fixture(t);
  const repo = path.join(root, 'repository');
  await initializeRepository(repo);
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
  await initializeRepository(repo);
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
  await initializeRepository(repo);
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
  await initializeRepository(repo);
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

test('the lock denies output redirection into a live build repository', async (t) => {
  const { root, runsRoot } = await fixture(t);
  const repo = path.join(root, 'repository');
  await initializeRepository(repo);
  await liveRun(runsRoot, { repo });
  const target = path.join(repo, 'CHANGELOG.md');
  const result = runShell(root, runsRoot, `printf changed > "${target}"`);
  const decision = JSON.parse(result.stdout).hookSpecificOutput;
  assert.equal(decision.permissionDecision, 'deny');
  assert.match(decision.permissionDecisionReason, /CHANGELOG\.md/);
});

test('the lock denies an interpreter heredoc that names a held path', async (t) => {
  const { root, runsRoot } = await fixture(t);
  const repo = path.join(root, 'repository');
  await initializeRepository(repo);
  await liveRun(runsRoot, { repo });
  const target = path.join(repo, 'generated.txt').replaceAll('\\', '/');
  const command = `python - <<'PY'\nopen('${target}', 'w').write('changed')\nPY`;
  const result = runShell(root, runsRoot, command);
  const decision = JSON.parse(result.stdout).hookSpecificOutput;
  assert.equal(decision.permissionDecision, 'deny');
  assert.match(decision.permissionDecisionReason, /generated\.txt/);
});

test('the lock allows ignored work but still denies a tracked path beside it', async (t) => {
  const { root, runsRoot } = await fixture(t);
  const repo = path.join(root, 'repository');
  await initializeRepository(repo);
  await fs.writeFile(path.join(repo, '.gitignore'), 'docs/plans/\n');
  const trackedPath = path.join(repo, 'docs', 'checklists', 'run.md');
  await fs.mkdir(path.dirname(trackedPath), { recursive: true });
  await fs.writeFile(trackedPath, 'tracked\n');
  const add = spawnSync('git', ['-C', repo, 'add', '--', trackedPath], { encoding: 'utf8' });
  assert.equal(add.status, 0, add.stderr);
  await liveRun(runsRoot, { repo });

  assertPass(runLock(root, runsRoot, 'Write', path.join(repo, 'docs', 'plans', 'Plan_49.md')));
  const tracked = runLock(root, runsRoot, 'Write', trackedPath);
  assert.equal(JSON.parse(tracked.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('the lock always denies git metadata paths', async (t) => {
  const { root, runsRoot } = await fixture(t);
  const repo = path.join(root, 'repository');
  await initializeRepository(repo);
  await liveRun(runsRoot, { repo });
  const result = runLock(root, runsRoot, 'Write', path.join(repo, '.git', 'HEAD'));
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

// Only a proven `ignored` may pass. This hook fails open on an unreadable INPUT — a payload it
// cannot parse says nothing about a repository — but "git could not answer" is different: it
// leaves the guard with no evidence the path is harmless, and passing on it would hand every
// non-repository worktree, and every host without git, a lock that never denies anything.
test('the lock still denies when git cannot prove the target is ignored', async (t) => {
  const { root, runsRoot } = await fixture(t);
  const repo = path.join(root, 'not-a-repository');
  await fs.mkdir(repo, { recursive: true });
  await liveRun(runsRoot, { repo });
  const outsideGit = runLock(root, runsRoot, 'Write', path.join(repo, 'file.txt'));
  assert.equal(JSON.parse(outsideGit.stdout).hookSpecificOutput.permissionDecision, 'deny');

  const unavailableRepo = path.join(root, 'repository');
  await initializeRepository(unavailableRepo);
  await liveRun(runsRoot, { repo: unavailableRepo });
  const withoutGit = runLock(
    root, runsRoot, 'Write', path.join(unavailableRepo, 'file.txt'), root, { PATH: '' },
  );
  assert.equal(JSON.parse(withoutGit.stdout).hookSpecificOutput.permissionDecision, 'deny');
});

test('an outside heredoc redirect is not overridden by document text', async (t) => {
  const { root, runsRoot } = await fixture(t);
  const repo = path.join(root, 'repository');
  await initializeRepository(repo);
  await liveRun(runsRoot, { repo });
  const target = path.join(root, 'outside', 'finding.md').replaceAll('\\', '/');
  const command = `cat > "${target}" <<'EOF'\n` + 'touch `\nEOF';
  assertPass(runShell(root, runsRoot, command));
});

test('the lock allows a shell command that merely reads', async (t) => {
  const { root, runsRoot } = await fixture(t);
  const repo = path.join(root, 'repository');
  await liveRun(runsRoot, { repo });
  assertPass(runShell(root, runsRoot, `git -C "${repo}" status --short`));
});

test('the lock allows a read-only pipeline with a quoted redirect character', async (t) => {
  const { root, runsRoot } = await fixture(t);
  const repo = path.join(root, 'repository');
  await initializeRepository(repo);
  await liveRun(runsRoot, { repo });
  const command = String.raw`awk '/^Host x/' ~/.ssh/config | sed -E 's#(A ).*#\1<redacted>#' | head -10`;
  assertPass(runShell(root, runsRoot, command, repo));
});

test('the lock allows a shell write outside every held repository', async (t) => {
  const { root, runsRoot } = await fixture(t);
  const repo = path.join(root, 'repository');
  await liveRun(runsRoot, { repo });
  const target = path.join(root, 'other-repository', 'file.txt');
  assertPass(runShell(root, runsRoot, `printf changed > "${target}"`));
});
