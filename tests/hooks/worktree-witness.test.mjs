/** Verifies the PostToolUse witness for shell writes outside a live build's scope. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  HOOK_DEFINITIONS,
  SHELL_TOOL_MATCHER,
} from '../../src/home/lib/hook-definitions.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const WITNESS = path.join(ROOT, 'src', 'home', 'hooks', 'worktree-witness.mjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-worktree-witness-'));
  const repo = path.join(root, 'repository');
  const runsRoot = path.join(root, 'runs');
  await fs.mkdir(repo, { recursive: true });
  await fs.mkdir(runsRoot, { recursive: true });
  assert.equal(spawnSync('git', ['init', '-q', repo]).status, 0);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, repo, runsRoot };
}

async function liveRun(runsRoot, repo, statusOverrides = {}) {
  const dir = path.join(runsRoot, 'project', '2026-08-16_split-guard');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'status.json'), `${JSON.stringify({
    state: 'running',
    pid: process.pid,
    agent: 'codex-build',
    slug: 'split-guard-20260816',
    repo,
    started_at: '2026-08-16T10:00:00.000Z',
    process_started_at: performance.timeOrigin,
    ...statusOverrides,
  })}\n`);
  await fs.writeFile(path.join(dir, 'git-before.txt'), '');
  await fs.writeFile(path.join(dir, 'scope.txt'), 'src/**\n');
  return dir;
}

function runWitness(root, runsRoot, cwd, input = {}) {
  return spawnSync(process.execPath, [WITNESS], {
    input: JSON.stringify({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'python - <<PY' },
      cwd,
      ...input,
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

test('the registry runs the witness after every supported shell tool', () => {
  const definition = HOOK_DEFINITIONS.find((entry) => entry.file === 'worktree-witness.mjs');
  assert.deepEqual(definition, {
    name: 'worktree-witness',
    event: 'PostToolUse',
    matcher: SHELL_TOOL_MATCHER,
    file: 'worktree-witness.mjs',
  });
});

test('no live run means silence', async (t) => {
  const { root, repo, runsRoot } = await fixture(t);
  await fs.writeFile(path.join(repo, 'CHANGELOG.md'), 'orchestrator edit\n');
  assertPass(runWitness(root, runsRoot, repo));
});

test('changes entirely inside the live run scope mean silence', async (t) => {
  const { root, repo, runsRoot } = await fixture(t);
  await liveRun(runsRoot, repo);
  await fs.mkdir(path.join(repo, 'src'));
  await fs.writeFile(path.join(repo, 'src', 'guard.mjs'), 'run edit\n');
  assertPass(runWitness(root, runsRoot, repo));
});

// These near-owner cases protect the shell-tool and repository-boundary guards from broadening.
test('only shell tools running inside the owned repository are witnessed', async (t) => {
  const { root, repo, runsRoot } = await fixture(t);
  await liveRun(runsRoot, repo);
  await fs.writeFile(path.join(repo, 'CHANGELOG.md'), 'orchestrator edit\n');
  const sibling = `${repo}-other`;
  await fs.mkdir(sibling);

  for (const { name, cwd, input } of [
    { name: 'non-shell tool', cwd: repo, input: { tool_name: 'Write' } },
    { name: 'prefix-sharing sibling repository', cwd: sibling, input: {} },
  ]) {
    await t.test(name, () => {
      assertPass(runWitness(root, runsRoot, cwd, input));
    });
  }
});

// Live-run eligibility must reject both terminal state and stale process ownership.
test('runs that are not live do not own repository changes', async (t) => {
  const deadProcess = spawnSync(process.execPath, ['-e', '']);
  assert.equal(deadProcess.status, 0);
  assert.ok(Number.isInteger(deadProcess.pid));

  for (const { name, status } of [
    { name: 'finished run', status: { state: 'finished' } },
    { name: 'dead process', status: { pid: deadProcess.pid } },
  ]) {
    await t.test(name, async (t) => {
      const { root, repo, runsRoot } = await fixture(t);
      await liveRun(runsRoot, repo, status);
      await fs.writeFile(path.join(repo, 'CHANGELOG.md'), 'orchestrator edit\n');
      assertPass(runWitness(root, runsRoot, repo));
    });
  }
});

test('a change outside scope is reported with the path and release command', async (t) => {
  const { root, repo, runsRoot } = await fixture(t);
  const runDir = await liveRun(runsRoot, repo);
  await fs.writeFile(path.join(repo, 'CHANGELOG.md'), 'orchestrator edit\n');

  const result = runWitness(root, runsRoot, repo);
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout).hookSpecificOutput;
  assert.equal(output.hookEventName, 'PostToolUse');
  assert.match(output.additionalContext, /act now/i);
  assert.match(output.additionalContext, /CHANGELOG\.md/);
  assert.match(output.additionalContext, new RegExp(runDir.replaceAll('\\', '\\\\')));
  assert.match(output.additionalContext, /agent codex-build/);
  assert.match(output.additionalContext, /slug split-guard-20260816/);
  assert.match(output.additionalContext, /codex-bridge stop 2026-08-16_split-guard/);
});

// Porcelain rename parsing must attribute ownership to the destination, not the obsolete source.
test('a renamed file is judged by its new path', async (t) => {
  const { root, repo, runsRoot } = await fixture(t);
  await liveRun(runsRoot, repo);
  await fs.writeFile(path.join(repo, 'old-name.txt'), 'tracked\n');
  assert.equal(spawnSync('git', ['-C', repo, 'add', 'old-name.txt']).status, 0);
  assert.equal(spawnSync('git', [
    '-C', repo,
    '-c', 'user.name=Worktree Witness',
    '-c', 'user.email=witness@example.test',
    'commit', '-qm', 'fixture',
  ]).status, 0);
  assert.equal(spawnSync('git', ['-C', repo, 'mv', 'old-name.txt', 'new-name.txt']).status, 0);

  const result = runWitness(root, runsRoot, repo);
  assert.equal(result.status, 0);
  const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /new-name\.txt/);
  assert.doesNotMatch(context, /old-name\.txt/);
});

// The before-only comparison protects the revert case where current porcelain becomes clean.
test('a path present only in git-before is reported as changed', async (t) => {
  const { root, repo, runsRoot } = await fixture(t);
  const runDir = await liveRun(runsRoot, repo);
  await fs.writeFile(path.join(runDir, 'git-before.txt'), ' M restored.txt\n');

  const result = runWitness(root, runsRoot, repo);
  assert.equal(result.status, 0);
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /restored\.txt/);
});

// Blank scope is intentionally non-enforcing so an absent declaration cannot claim violations.
test('an empty scope passes silently', async (t) => {
  const { root, repo, runsRoot } = await fixture(t);
  const runDir = await liveRun(runsRoot, repo);
  await fs.writeFile(path.join(runDir, 'scope.txt'), '\n  \n');
  await fs.writeFile(path.join(repo, 'CHANGELOG.md'), 'orchestrator edit\n');
  assertPass(runWitness(root, runsRoot, repo));
});

// Multiple scope patterns must be evaluated independently before collecting outside paths.
test('several scope patterns filter each changed path', async (t) => {
  const { root, repo, runsRoot } = await fixture(t);
  const runDir = await liveRun(runsRoot, repo);
  await fs.writeFile(path.join(runDir, 'scope.txt'), 'src/**\ndocs/*.md\n');
  await fs.mkdir(path.join(repo, 'src'));
  await fs.mkdir(path.join(repo, 'docs'));
  await fs.mkdir(path.join(repo, 'tests'));
  await fs.writeFile(path.join(repo, 'src', 'guard.mjs'), 'allowed\n');
  await fs.writeFile(path.join(repo, 'docs', 'guide.md'), 'allowed\n');
  await fs.writeFile(path.join(repo, 'tests', 'guard.test.mjs'), 'outside\n');
  assert.equal(spawnSync('git', [
    '-C', repo, 'add', '-N', 'src/guard.mjs', 'docs/guide.md', 'tests/guard.test.mjs',
  ]).status, 0);

  const result = runWitness(root, runsRoot, repo);
  assert.equal(result.status, 0);
  const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /tests\/guard\.test\.mjs/);
  assert.doesNotMatch(context, /src\/guard\.mjs/);
  assert.doesNotMatch(context, /docs\/guide\.md/);
});

test('malformed and missing inputs pass silently', async (t) => {
  const { root, repo, runsRoot } = await fixture(t);
  const runDir = await liveRun(runsRoot, repo);
  await fs.writeFile(path.join(repo, 'CHANGELOG.md'), 'orchestrator edit\n');

  const malformedJson = spawnSync(process.execPath, [WITNESS], {
    input: '{',
    encoding: 'utf8',
    env: { ...process.env, CODEX_RUNS_ROOT: runsRoot, HOME: root, USERPROFILE: root },
  });
  assertPass(malformedJson);
  await fs.rm(path.join(runDir, 'git-before.txt'));
  assertPass(runWitness(root, runsRoot, repo));
  await fs.writeFile(path.join(runDir, 'git-before.txt'), 'not porcelain\n');
  assertPass(runWitness(root, runsRoot, repo));
  await fs.rm(path.join(runDir, 'scope.txt'));
  assertPass(runWitness(root, runsRoot, repo));
});
