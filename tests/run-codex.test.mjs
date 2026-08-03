#!/usr/bin/env node
/**
 * Guards run-codex.mjs: the decisions it makes before spending anyone's quota.
 *   node --test agents/codex/run-codex.test.mjs
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
import { parseArgs, runsPrefixInside, worktreeSnapshot } from '../src/run-codex.mjs';
import { codexArgs } from '../src/runner/codex-cmd.mjs';
import { loadRunEnv } from '../src/runner/run-env.mjs';
import { runsRoot } from '../src/runner/runs-root.mjs';

/** Resolved from this file, so a copied folder tests its own copy of the runner. */
const RUN_CODEX = new URL('../src/run-codex.mjs', import.meta.url).href;

/**
 * Non-ASCII travels through an environment variable at the mercy of the code page, so the
 * argv handed to a child is escaped down to plain ASCII and parsed back on the other side.
 */
const jsonAscii = (value) =>
  JSON.stringify(value).replace(
    /[\u0080-\uffff]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );

/**
 * parseArgs refuses by exiting the process, and that exit code IS the refusal — a dispatcher
 * branches on it. So it is asked in a child process and judged by what the child returns.
 */
function parseArgsInChild(argv) {
  const source = `import { parseArgs } from ${JSON.stringify(RUN_CODEX)};
process.stdout.write(JSON.stringify(parseArgs(JSON.parse(process.env.CODEX_TEST_ARGV))));`;
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8',
    env: { ...process.env, CODEX_TEST_ARGV: jsonAscii(argv) },
  });
  return { code: out.status, stderr: out.stderr || '', opts: out.stdout ? JSON.parse(out.stdout) : null };
}

test('importing the runner starts nothing', () => {
  // Every refusal and every artifact of a run lives behind a direct call. Imported — which is
  // how the cases here reach it — the file must not parse arguments, read stdin, take the
  // --worker branch or spawn anything: a runner that ran on import would run inside the tests.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cwd-'));
  const source = `await import(${JSON.stringify(RUN_CODEX)});
process.stdout.write('imported');`;

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

// Every run carries the order label the orchestrator issued, so these cases spell it out
// rather than testing the --order-id refusal by accident; that refusal has its own cases below.
const ORDER = ['--order-id', 'ord-1'];

test('parseArgs refuses a run with no order label', () => {
  // The label is what caught the two self-restarts of this project: a dispatcher that renames
  // itself has no honest source of a new one. So it is required, never defaulted, and never
  // invented by the runner — a runner-issued label would be fresh on a restart and the chain
  // would miss again.
  for (const argv of [['--agent', 'codex-scout'], ['--agent', 'codex-scout', '--order-id', '   ']]) {
    const { code, stderr } = parseArgsInChild(argv);
    assert.equal(code, 2, JSON.stringify(argv));
    assert.match(stderr, /--order-id is required/);
  }
});

test('the order label is stored trimmed', () => {
  const { code, opts } = parseArgsInChild(['--agent', 'codex-scout', '--order-id', '  order-42  ']);
  assert.equal(code, 0);
  assert.equal(opts.orderId, 'order-42');
});

test('--continue with no value is consent', () => {
  const { code, opts } = parseArgsInChild(['--agent', 'codex-scout', ...ORDER, '--continue']);
  assert.equal(code, 0);
  assert.equal(opts.continue, true);
});

test('the spelled-out yes and no of --continue are both honoured', () => {
  for (const value of ['1', 'true', 'yes']) {
    const { code, opts } = parseArgsInChild(['--agent', 'codex-scout', ...ORDER, '--continue', value]);
    assert.equal(code, 0, `--continue ${value}`);
    assert.equal(opts.continue, true, `--continue ${value}`);
  }
  for (const value of ['0', 'false', 'no']) {
    const { code, opts } = parseArgsInChild(['--agent', 'codex-scout', ...ORDER, '--continue', value]);
    assert.equal(code, 0, `--continue ${value}`);
    assert.equal(opts.continue, false, `--continue ${value}`);
  }
});

test('a placeholder left in from the prompt template is not consent', () => {
  // The permissive reading this replaces — "anything but 0/false/no means yes" — turned the
  // agent prompt's own `--continue "<only if the orchestrator provided continue>"` into a silent
  // opt-in, and a repeat run started on someone else's quota. The refusal is exit code 2.
  for (const value of ['<only if the orchestrator provided continue>', 'maybe', '']) {
    const { code, stderr } = parseArgsInChild(['--agent', 'codex-scout', ...ORDER, '--continue', value]);
    assert.equal(code, 2, `--continue ${JSON.stringify(value)}`);
    assert.match(stderr, /takes no value, or one of 1\/true\/yes\/0\/false\/no/);
  }
});

test('--continue does not swallow the flag that follows it', () => {
  const { code, opts } = parseArgsInChild([
    '--agent',
    'codex-scout',
    ...ORDER,
    '--continue',
    '--scope',
    'src/**',
  ]);
  assert.equal(code, 0);
  assert.equal(opts.continue, true);
  assert.equal(opts.scope, 'src/**');
});

// The prompts also say not to delegate, and prompts are what a dispatcher already ignored twice
// in this project. The flag is the half that cannot be talked out of.
test('no runner mode leaves subagent spawning available', () => {
  loadRunEnv();
  const runDir = path.join(os.tmpdir(), 'codex-run');
  for (const agent of ['codex-scout', 'codex-build', 'codex-review']) {
    const args = codexArgs({ agent, repo: process.cwd() }, runDir, true);
    assert.equal(args.filter((arg) => arg === 'agents.enabled=false').length, 1, agent);
  }
});

test('no runner mode disables installed Codex rules', () => {
  loadRunEnv();
  const runDir = path.join(os.tmpdir(), 'codex-run');
  for (const agent of ['codex-scout', 'codex-build', 'codex-review']) {
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
  for (const agent of ['codex-scout', 'codex-build', 'codex-review']) {
    const args = codexArgs({ agent, effort: 'medium', repo: process.cwd(), models: {} }, runDir, true);
    assert.equal(args.includes('-m'), false, agent);
  }
});

/**
 * A repository that physically contains the run folders, with homedir() pointed at the
 * fixture for as long as `body` runs. Git is cut off from the operator's own config too, so
 * the fixture answers for itself instead of for whatever ~/.gitconfig happens to exclude.
 */
function withHomeRepo(body) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  const keys = ['HOME', 'USERPROFILE', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM'];
  const saved = keys.map((key) => [key, process.env[key]]);
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
    for (const value of [undefined, '', '   ']) {
      withRunsRoot(value, () => {
        assert.equal(runsRoot(), path.join(home, '.claude', 'codex-runs'));
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
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-repo-'));
  withRunsRoot(path.join(repo, 'artifacts'), () => {
    assert.equal(runsPrefixInside(repo), 'artifacts/');
  });
  withRunsRoot(path.join(os.tmpdir(), 'external-codex-runs'), () => {
    assert.equal(runsPrefixInside(repo), null);
  });
});

test('the run folders are located relative to the repository that hosts them', () => {
  withHomeRepo((home) => {
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

    const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    git('init', '-q');
    git('add', '-A');
    git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'base');

    // Tracked edits on both sides of the prefix.
    fs.writeFileSync(path.join(repo, 'agents', 'note.md'), 'one\ntwo\n');
    fs.writeFileSync(path.join(runFolder, 'state-after.txt'), 'one\ntwo\n');
    // Untracked files on both sides of the prefix.
    fs.writeFileSync(path.join(repo, 'agents', 'fresh.md'), 'new\n');
    fs.writeFileSync(path.join(runFolder, 'raw.log'), 'codex output\n');

    const snapshot = worktreeSnapshot(repo);

    assert.match(snapshot, /agents\/note\.md/);
    assert.match(snapshot, /agents\/fresh\.md/);
    assert.doesNotMatch(snapshot, /codex-runs/);
  });
});
