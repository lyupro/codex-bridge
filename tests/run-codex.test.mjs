#!/usr/bin/env node
/**
 * Guards run-codex.mjs: the decisions it makes before spending anyone's quota.
 *   node --test agents/codex-bridge/run-codex.test.mjs
 *
 * It is imported, not executed — and that importing it starts nothing is itself one of the
 * cases below. Split out of write-meta.test.mjs (which still guards the write-meta.mjs
 * facade) because this file tests a different module entirely; the two used to share one
 * file for convenience, not because the coverage overlapped.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runsPrefixInside, worktreeSnapshot } from '../src/home/lib/run-codex.mjs';
import { codexArgs } from '../src/home/lib/runner/codex-args.mjs';
import { loadRunEnv } from '../src/home/lib/runner/run-env.mjs';
import { runsRoot } from '../src/home/lib/runner/runs-root.mjs';
import { makeTempTree } from './temp-tree.mjs';
import { orderInvocation } from './runner/order-invocation.mjs';

/** Resolved from this file, so a copied folder tests its own copy of the runner. */
const RUN_CODEX = new URL('../src/home/lib/run-codex.mjs', import.meta.url).href;

/**
 * Non-ASCII travels through an environment variable at the mercy of the code page, so the
 * argv handed to a child is escaped down to plain ASCII and parsed back on the other side.
 */
const jsonAscii = (value) =>
  JSON.stringify(value).replace(
    /[\u0080-\uffff]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );

test('importing the runner starts nothing', () => {
  // Every refusal and every artifact of a run lives behind a direct call. Imported — which is
  // how the cases here reach it — the file must not parse arguments, read stdin, take the
  // --worker branch or spawn anything: a runner that ran on import would run inside the tests.
  const home = makeTempTree('codex-home-');
  const cwd = makeTempTree('codex-cwd-');
  const source = `await import(${JSON.stringify(RUN_CODEX)});
process.stdout.write('imported');`;

  // raw argv: Node imports the facade in isolation to prove that import has no side effects.
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8',
    cwd,
    input: '',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });

  // A launcher that started would have died on `--agent is required` with code 2 instead.
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout, 'imported');
  assert.deepEqual(fs.readdirSync(cwd), []);
  assert.deepEqual(fs.readdirSync(home), []);
});

// Plan_63 D8 keeps order validation after transport parsing, on the task-header path.
function headerArgsInChild(order, { grant, agent = 'codex-scout', launch = false } = {}) {
  const root = makeTempTree('header-args-');
  const { argv } = orderInvocation({
    agent, order, grant, advice: agent === 'codex-build' ? 'mechanical' : undefined, questions: ['Describe the current implementation.'], dir: root,
  });
  const taskInput = new URL('../src/home/lib/runner/task-input.mjs', import.meta.url).href;
  const launcher = new URL('../src/home/lib/runner/launcher.mjs', import.meta.url).href;
  const source = `import { parseArgs } from ${JSON.stringify(RUN_CODEX)};
import { settleTaskInput } from ${JSON.stringify(taskInput)};
try {
  const argv = JSON.parse(process.env.CODEX_TEST_ARGV);
  if (${launch}) {
    // raw argv: valid transport reaches the launcher with an impossible scope as a no-spend boundary.
    process.argv = [process.execPath, ${JSON.stringify(launcher)}, ...argv];
    const { launcher } = await import(${JSON.stringify(launcher)});
    const code = await launcher();
    if (code !== undefined) process.exitCode = code;
  } else {
    const opts = parseArgs(argv);
    settleTaskInput(opts);
    process.stdout.write(JSON.stringify(opts));
  }
} catch (err) { process.exit(err.exitCode || 1); }`;
  // raw argv: Node executes the isolated header-validation child without starting a worker.
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8', env: { ...process.env, CODEX_TEST_ARGV: jsonAscii(argv), CODEX_RUNS_ROOT: path.join(root, 'runs') },
  });
  return { code: out.status, stderr: out.stderr || '', opts: out.stdout ? JSON.parse(out.stdout) : null };
}

test('the header refuses a run with no order label', () => {
  // The two self-restarts incident requires an orchestrator-issued label, never a runner default.
  for (const order of [{}, { 'order id': '   ' }]) {
    const { code, stderr } = headerArgsInChild(order);
    assert.equal(code, 2, JSON.stringify(order));
    assert.match(stderr, Object.hasOwn(order, 'order id')
      ? /header label "order id" has an empty value/
      : /missing required header label "order id:"/);
  }
});

test('the order label is stored trimmed from the header', () => {
  const { code, opts, stderr } = headerArgsInChild({ 'order id': '  order-42  ' });
  assert.equal(code, 0, stderr);
  assert.equal(opts.orderId, 'order-42');
});

test('a continuation or retry grant alone authorises continuation and preserves scope', () => {
  for (const kind of ['continue', 'retry']) {
    const { code, opts, stderr } = headerArgsInChild({ 'order id': 'ord-1', scope: 'src/**' }, {
      agent: 'codex-build', grant: { kind, run: 'previous-run', reason: 'finish the task' },
    });
    assert.equal(code, 0, stderr);
    assert.equal(opts.continue, true, kind);
    assert.deepEqual(opts.scopePatterns, ['src/**'], kind);
  }
  const { code, opts, stderr } = headerArgsInChild({ 'order id': 'ord-1' });
  assert.equal(code, 0, stderr);
  assert.equal(opts.continue, false);
});

test('the header refuses a whitespace-containing effort with its label and exit code 2', () => {
  const { code, stderr } = headerArgsInChild({ 'order id': 'ord-1', effort: 'two words' });
  assert.equal(code, 2, stderr);
  assert.equal(stderr.trim(),
    'run-codex: `effort:` must be a non-empty single word with no whitespace; got "two words"');
});

test('the header refuses an unusable slug and shell-unsafe effort before starting', () => {
  for (const [order, refusal] of [
    [{ 'order id': 'ord-1', slug: '___' }, /`slug:` produces an unusable run folder name/],
    [{ 'order id': 'ord-1', effort: '$(echo)' }, /`effort:` contains forbidden shell sequence/],
  ]) {
    const { code, stderr } = Object.hasOwn(order, 'effort')
      ? headerArgsInChild({ ...order, scope: '/absolute-is-refused' }, { agent: 'codex-build', launch: true })
      : headerArgsInChild(order);
    assert.equal(code, 2, stderr);
    assert.match(stderr, refusal);
  }
});

// The prompts also say not to delegate, and prompts are what a dispatcher already ignored twice
// in this project. The flag is the half that cannot be talked out of.
test('no runner mode leaves subagent spawning available', () => {
  loadRunEnv();
  const runDir = path.join(os.tmpdir(), 'codex-run');
  for (const agent of ['codex-scout', 'codex-build', 'codex-review', 'codex-advisor']) {
    const args = codexArgs({ agent, repo: process.cwd() }, runDir, true);
    assert.equal(args.filter((arg) => arg === 'agents.enabled=false').length, 1, agent);
  }
});

test('no runner mode disables installed Codex rules', () => {
  loadRunEnv();
  const runDir = path.join(os.tmpdir(), 'codex-run');
  for (const agent of ['codex-scout', 'codex-build', 'codex-review', 'codex-advisor']) {
    const args = codexArgs({ agent, effort: 'medium', repo: process.cwd() }, runDir, true);
    assert.equal(args.includes('--ignore-rules'), false, agent);
  }
});

test('each runner mode passes its configured model exactly once', () => {
  loadRunEnv();
  const runDir = path.join(os.tmpdir(), 'codex-run');
  const cases = [
    ['codex-scout', 'scout'],
    ['codex-build', 'build'],
    ['codex-review', 'review'],
    ['codex-advisor', 'advisor'],
  ];
  for (const [agent, key] of cases) {
    const model = `model-${key}`;
    const args = codexArgs(
      { agent, effort: 'medium', repo: process.cwd(), models: { [key]: { model } } },
      runDir,
      true,
    );
    assert.equal(args.filter((arg) => arg === '-m').length, 1, agent);
    assert.equal(args[args.indexOf('-m') + 1], model, agent);
    assert.ok(args.indexOf('-m') < args.indexOf('--sandbox'), agent);
  }
});

// The pair is the point: a mode pinned to a model but left at the fallback depth is a
// different worker from the one the operator configured, and the difference is invisible
// in the arguments unless something asserts on it.
test('reasoning depth comes from the request first, then the mode profile, then the fallback', () => {
  loadRunEnv();
  const runDir = path.join(os.tmpdir(), 'codex-run');
  const depthOf = (args) => args[args.indexOf('-c') + 1];
  const profile = { models: { build: { model: 'model-b', effort: 'max' } } };

  const configured = codexArgs({ agent: 'codex-build', repo: process.cwd(), ...profile }, runDir, true);
  assert.equal(depthOf(configured), 'model_reasoning_effort=max');

  const asked = codexArgs(
    { agent: 'codex-build', effort: 'low', repo: process.cwd(), ...profile },
    runDir,
    true,
  );
  assert.equal(depthOf(asked), 'model_reasoning_effort=low');

  const bare = codexArgs({ agent: 'codex-build', repo: process.cwd(), models: {} }, runDir, true);
  assert.equal(depthOf(bare), 'model_reasoning_effort=medium');
});

test('runner modes omit the model flag when their model is not configured', () => {
  loadRunEnv();
  const runDir = path.join(os.tmpdir(), 'codex-run');
  for (const agent of ['codex-scout', 'codex-build', 'codex-review', 'codex-advisor']) {
    const args = codexArgs({ agent, effort: 'medium', repo: process.cwd(), models: {} }, runDir, true);
    assert.equal(args.includes('-m'), false, agent);
  }
});

test('all runner modes request the structured JSON event stream', () => {
  loadRunEnv();
  const runDir = path.join(os.tmpdir(), 'codex-run');
  for (const agent of ['codex-scout', 'codex-build', 'codex-review', 'codex-advisor']) {
    const args = codexArgs({ agent, effort: 'medium', repo: process.cwd() }, runDir, true);
    assert.equal(args.filter((arg) => arg === '--json').length, 1, agent);
  }
});

/**
 * A repository that physically contains the run folders, with homedir() pointed at the
 * fixture for as long as `body` runs. Git is cut off from the operator's own config too, so
 * the fixture answers for itself instead of for whatever ~/.gitconfig happens to exclude.
 * The runs root override is lifted as well: these cases are about the location derived from
 * homedir(), and the suite runner now always sets one (Plan_65 B12).
 */
function withHomeRepo(body) {
  const home = makeTempTree('codex-home-');
  const keys = ['HOME', 'USERPROFILE', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'CODEX_RUNS_ROOT'];
  const saved = keys.map((key) => [key, process.env[key]]);
  delete process.env.CODEX_RUNS_ROOT;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.GIT_CONFIG_GLOBAL = path.join(home, 'no-such-gitconfig');
  process.env.GIT_CONFIG_SYSTEM = path.join(home, 'no-such-gitconfig');
  try {
    return body(home);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function withRunsRoot(value, body) {
  const saved = process.env.CODEX_RUNS_ROOT;
  if (value === undefined) delete process.env.CODEX_RUNS_ROOT;
  else process.env.CODEX_RUNS_ROOT = value;
  try {
    return body();
  } finally {
    if (saved === undefined) delete process.env.CODEX_RUNS_ROOT;
    else process.env.CODEX_RUNS_ROOT = saved;
  }
}

test('the runs root defaults to the existing home directory location', () => {
  withHomeRepo((home) => {
    // Plan_77 D7 preserves the old store only when it exists and the move is still pending.
    fs.mkdirSync(path.join(home, '.claude', 'codex-runs'), { recursive: true });
    for (const value of [undefined, '', '   ']) {
      withRunsRoot(value, () => {
        assert.equal(runsRoot(), path.join(home, '.claude', 'codex-runs'));
      });
    }
  });
});

test('the runs root defaults to the package home without a legacy directory', () => {
  withHomeRepo(() => {
    for (const value of [undefined, '', '   ']) {
      withRunsRoot(value, () => {
        assert.equal(runsRoot(), path.join(process.env.CODEX_BRIDGE_HOME, 'runs'));
      });
    }
  });
});

test('the runs root uses a non-empty environment override, trimmed', () => {
  const configured = path.join(os.tmpdir(), 'custom-codex-runs');
  withRunsRoot(configured, () => {
    assert.equal(runsRoot(), configured);
  });
  // Padding survives a shell or an .env line easily; a folder named with it does not.
  withRunsRoot(` ${configured} `, () => {
    assert.equal(runsRoot(), configured);
  });
});

test('the run folder prefix is calculated from the environment root', () => {
  const repo = makeTempTree('codex-repo-');
  withRunsRoot(path.join(repo, 'artifacts'), () => {
    assert.equal(runsPrefixInside(repo), 'artifacts/');
  });
  withRunsRoot(path.join(os.tmpdir(), 'external-codex-runs'), () => {
    assert.equal(runsPrefixInside(repo), null);
  });
});

test('the run folders are located relative to the repository that hosts them', () => {
  withHomeRepo((home) => {
    fs.mkdirSync(path.join(home, '.claude', 'codex-runs'), { recursive: true });
    // ~/.claude itself: the runs sit one level down, and the prefix ends on a separator so
    // that a sibling folder named `codex-runs-old` cannot match it.
    assert.equal(runsPrefixInside(path.join(home, '.claude')), 'codex-runs/');
    // A repository the runs are nested deeper inside.
    assert.equal(runsPrefixInside(home), '.claude/codex-runs/');
    // A repository they are not inside at all: nothing to skip.
    assert.equal(runsPrefixInside(path.join(home, 'elsewhere')), null);
  });
});

test('a run does not see its own artifacts as work in the tree it measures', () => {
  // ~/.claude hosts both the dispatchers and every run folder, so a run against it snapshots
  // its own git-after.txt and state-before.txt as edits — one such run failed with “out-of-scope
  // changes” listing nothing but the instrument it was being measured with.
  withHomeRepo((home) => {
    const repo = path.join(home, '.claude');
    const runFolder = path.join(repo, 'codex-runs', 'proj', '2026-07-31_120000_task');
    fs.mkdirSync(path.join(repo, 'agents'), { recursive: true });
    fs.mkdirSync(runFolder, { recursive: true });
    fs.writeFileSync(path.join(repo, 'agents', 'note.md'), 'one\n');
    fs.writeFileSync(path.join(runFolder, 'state-after.txt'), 'one\n');

    // raw argv: Git creates and measures the throwaway fixture, never the project worktree.
    const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    git('init', '-q');
    git('add', '-A');
    git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'base');

    // Tracked edits on both sides of the prefix.
    fs.writeFileSync(path.join(repo, 'agents', 'note.md'), 'one\ntwo\n');
    fs.writeFileSync(path.join(runFolder, 'state-after.txt'), 'one\ntwo\n');
    // Untracked files on both sides of the prefix.
    fs.writeFileSync(path.join(repo, 'agents', 'fresh.md'), 'new\n');
    fs.writeFileSync(path.join(runFolder, 'events.jsonl'), 'codex output\n');

    const snapshot = worktreeSnapshot(repo);

    assert.match(snapshot, /agents\/note\.md/);
    assert.match(snapshot, /agents\/fresh\.md/);
    assert.doesNotMatch(snapshot, /codex-runs/);
  });
});
