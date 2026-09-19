/** Verifies the PostToolUse witness for shell writes outside a live build's scope. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  HOOK_DEFINITIONS,
  SHELL_TOOL_MATCHER,
} from '../../src/home/lib/hook-definitions.mjs';
import { worktreeSnapshot } from '../../src/home/lib/runner/git-state.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const WITNESS = path.join(ROOT, 'src', 'home', 'hooks', 'worktree-witness.mjs');

async function fixture(t) {
  const root = makeTempTree('bridge-worktree-witness-');
  const repo = path.join(root, 'repository');
  const runsRoot = path.join(root, 'runs');
  await fs.mkdir(repo, { recursive: true });
  await fs.mkdir(runsRoot, { recursive: true });
  assert.equal(spawnSync('git', ['init', '-q', repo]).status, 0);
  // The verdict's snapshot diffs against HEAD; an unborn fixture hides tracked scope changes.
  assert.equal(spawnSync('git', [
    '-C', repo,
    '-c', 'user.name=Worktree Witness',
    '-c', 'user.email=witness@example.test',
    'commit', '--allow-empty', '-qm', 'fixture baseline',
  ]).status, 0);
  t.after(() => removeTempTree(root));
  return { root, repo, runsRoot };
}

async function liveRun(runsRoot, repo, statusOverrides = {}) {
  // A pid carries the start time of THAT process or the record means nothing: identity compares
  // the two against a 1000ms tolerance (process-identity.mjs), and overriding one alone leaves a
  // pid belonging to process A dated by process B. This file wrote exactly that shape and the
  // suite paid for it — Windows handed the dead pid to a freshly spawned neighbour, whose start
  // sat ~37ms from the test process's own, so a dead run read as alive and the witness fired.
  if ('pid' in statusOverrides && !('process_started_at' in statusOverrides)) {
    throw new Error('liveRun: overriding pid requires process_started_at of that same process');
  }
  const before = worktreeSnapshot(repo);
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
  await fs.writeFile(path.join(dir, 'state-before.txt'), `${before}\n`);
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
  // Stale ownership means a run that started long ago, so the record is dated to its own
  // started_at rather than to this moment. Both roads then lead to "not live" without depending
  // on the pid staying free: an untaken pid answers ESRCH, and a pid Windows has already reused
  // answers with today's start time, which no tolerance can reconcile with August. Reading the
  // dead process's real start time would not do — a neighbour can seize the pid within the same
  // second it died, land inside the tolerance, and pass for this run all over again.
  const runStartedAt = Date.parse('2026-08-16T10:00:00.000Z');

  for (const { name, status } of [
    { name: 'finished run', status: { state: 'finished' } },
    {
      name: 'dead process',
      status: { pid: deadProcess.pid, process_started_at: runStartedAt },
    },
  ]) {
    await t.test(name, async (t) => {
      const { root, repo, runsRoot } = await fixture(t);
      await liveRun(runsRoot, repo, status);
      await fs.writeFile(path.join(repo, 'CHANGELOG.md'), 'orchestrator edit\n');
      assertPass(runWitness(root, runsRoot, repo));
    });
  }
});

// The 2026-09-19 exclusions must still leave real orchestrator edits visible and actionable.
test('a change outside scope is reported with the path and release command', async (t) => {
  const { root, repo, runsRoot } = await fixture(t);
  const runDir = await liveRun(runsRoot, repo);
  await fs.writeFile(path.join(repo, 'CHANGELOG.md'), 'orchestrator edit\n');

  const result = runWitness(root, runsRoot, repo);
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout).hookSpecificOutput;
  assert.equal(output.hookEventName, 'PostToolUse');
  assert.match(output.additionalContext, /^WORKTREE WITNESS/);
  assert.match(output.additionalContext, /run's own folder, environment paths and gitignored files are already excluded/);
  assert.match(output.additionalContext, /orchestrator's own edits inside the repository/);
  assert.match(output.additionalContext, /act now/i);
  assert.match(output.additionalContext, /CHANGELOG\.md/);
  assert.match(output.additionalContext, new RegExp(runDir.replaceAll('\\', '\\\\')));
  assert.match(output.additionalContext, /agent codex-build/);
  assert.match(output.additionalContext, /slug split-guard-20260816/);
  assert.match(output.additionalContext, /codex-bridge stop 2026-08-16_split-guard/);
  assert.ok(output.additionalContext.indexOf("orchestrator's own edits") < output.additionalContext.indexOf('Act now'));
});

// On 2026-09-19 a run under ~/.claude was falsely accused of creating its own run folder.
test('artifacts inside the live run folder are not reported', async (t) => {
  const { root, repo } = await fixture(t);
  const runsRoot = path.join(repo, 'runs');
  const runDir = await liveRun(runsRoot, repo);
  await fs.writeFile(path.join(runDir, 'raw.log'), 'run artifact\n');
  assertPass(runWitness(root, runsRoot, repo));
});

// Environment ownership comes from the live run's env.json, as it does for the verdict.
test('paths listed in environmentPaths are not reported', async (t) => {
  const { root, repo, runsRoot } = await fixture(t);
  const runDir = await liveRun(runsRoot, repo);
  const environmentPaths = ['.omc/project-memory.json', '.claude/settings.local.json', 'tooling/**'];
  await fs.writeFile(path.join(runDir, 'env.json'), JSON.stringify({ environmentPaths }));
  for (const file of ['.omc/project-memory.json', '.claude/settings.local.json', 'tooling/session.json']) {
    await fs.mkdir(path.dirname(path.join(repo, file)), { recursive: true });
    await fs.writeFile(path.join(repo, file), '{}\n');
  }
  assertPass(runWitness(root, runsRoot, repo));
  await fs.writeFile(path.join(repo, 'outside.txt'), 'orchestrator edit\n');
  const result = runWitness(root, runsRoot, repo);
  assert.equal(result.status, 0);
  const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
  assert.match(context, /outside\.txt/);
  assert.doesNotMatch(context, /project-memory\.json|settings\.local\.json|session\.json/);
});

// Gitignored working notes are absent from the verdict's instrument and must stay absent here.
test('gitignored working notes are not reported', async (t) => {
  const { root, repo, runsRoot } = await fixture(t);
  await fs.writeFile(path.join(repo, '.gitignore'), 'notes/\n');
  await liveRun(runsRoot, repo);
  await fs.mkdir(path.join(repo, 'notes'));
  await fs.writeFile(path.join(repo, 'notes', 'scratch.md'), 'working notes\n');
  assertPass(runWitness(root, runsRoot, repo));
});

// Porcelain stays ?? for an existing untracked file; the recorded byte count catches its edit.
test('an edit to an already untracked path is reported', async (t) => {
  const { root, repo, runsRoot } = await fixture(t);
  await fs.writeFile(path.join(repo, 'outside.txt'), 'before\n');
  await liveRun(runsRoot, repo);
  assertPass(runWitness(root, runsRoot, repo));
  await fs.writeFile(path.join(repo, 'outside.txt'), 'orchestrator changed the file\n');
  const result = runWitness(root, runsRoot, repo);
  assert.equal(result.status, 0);
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /outside\.txt/);
});

// Line counts catch further tracked edits that leave the same porcelain status letter behind.
test('an edit to an already modified tracked path is reported', async (t) => {
  const { root, repo, runsRoot } = await fixture(t);
  await fs.writeFile(path.join(repo, 'outside.txt'), 'before\n');
  assert.equal(spawnSync('git', ['-C', repo, 'add', '-N', 'outside.txt']).status, 0);
  await liveRun(runsRoot, repo);
  assertPass(runWitness(root, runsRoot, repo));
  await fs.appendFile(path.join(repo, 'outside.txt'), 'orchestrator edit\n');
  const result = runWitness(root, runsRoot, repo);
  assert.equal(result.status, 0);
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /outside\.txt/);
});

// Plan_58 keeps the launcher artifact for diagnostics, but it no longer measures witness changes.
test('git-before is ignored and preserved as an artifact', async (t) => {
  const { root, repo, runsRoot } = await fixture(t);
  const runDir = await liveRun(runsRoot, repo);
  const legacy = path.join(runDir, 'git-before.txt');
  await fs.writeFile(legacy, 'not porcelain\n');
  await fs.writeFile(path.join(repo, 'outside.txt'), 'orchestrator edit\n');
  const result = runWitness(root, runsRoot, repo);
  assert.equal(result.status, 0);
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /outside\.txt/);
  assert.equal(await fs.readFile(legacy, 'utf8'), 'not porcelain\n');
});

// A rename is two facts, and the snapshot is read with `--no-renames` so both are real paths. The
// porcelain witness named only the destination; the shared instrument once named the token
// `old => new`, which is no path at all and matches no scope pattern (Plan_58 acceptance).
test('a renamed file is judged by both of its paths', async (t) => {
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
  assert.match(context, /old-name\.txt/);
  assert.doesNotMatch(context, /=>/, 'a rename token is not a path and must never reach the reply');
});

// The verdict judges strays with this same snapshot, so the rename token would have failed an
// honest build for moving a file it was told to own. Silence here is what proves it cannot.
test('a rename that stays inside the scope is not reported', async (t) => {
  const { root, repo, runsRoot } = await fixture(t);
  await fs.mkdir(path.join(repo, 'src'), { recursive: true });
  await fs.writeFile(path.join(repo, 'src', 'old-name.txt'), 'tracked\n');
  assert.equal(spawnSync('git', ['-C', repo, 'add', 'src/old-name.txt']).status, 0);
  assert.equal(spawnSync('git', [
    '-C', repo,
    '-c', 'user.name=Worktree Witness',
    '-c', 'user.email=witness@example.test',
    'commit', '-qm', 'fixture',
  ]).status, 0);
  await liveRun(runsRoot, repo);
  assert.equal(spawnSync('git', ['-C', repo, 'mv', 'src/old-name.txt', 'src/new-name.txt']).status, 0);

  const result = runWitness(root, runsRoot, repo);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '', result.stdout);
});

// The before-only comparison protects the revert case where the current snapshot becomes clean.
test('a path present only in state-before is reported as changed', async (t) => {
  const { root, repo, runsRoot } = await fixture(t);
  const runDir = await liveRun(runsRoot, repo);
  await fs.writeFile(path.join(runDir, 'state-before.txt'), '1\t0\trestored.txt\n');

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
  await fs.rm(path.join(runDir, 'state-before.txt'));
  assertPass(runWitness(root, runsRoot, repo));
  await fs.writeFile(path.join(runDir, 'state-before.txt'), 'not a snapshot\n');
  assertPass(runWitness(root, runsRoot, repo));
  await fs.writeFile(path.join(runDir, 'state-before.txt'), '');
  await fs.rm(path.join(runDir, 'scope.txt'));
  assertPass(runWitness(root, runsRoot, repo));
});

// An unreadable repository must not turn a nonempty baseline into a fabricated restoration.
test('an unavailable repository passes silently', async (t) => {
  const { root, repo, runsRoot } = await fixture(t);
  const runDir = await liveRun(runsRoot, repo);
  await fs.writeFile(path.join(runDir, 'state-before.txt'), '1\t0\trestored.txt\n');
  const statusFile = path.join(runDir, 'status.json');
  const status = JSON.parse(await fs.readFile(statusFile, 'utf8'));
  const missing = path.join(root, 'missing-repository');
  await fs.writeFile(statusFile, JSON.stringify({ ...status, repo: missing }));
  assertPass(runWitness(root, runsRoot, missing));
});
