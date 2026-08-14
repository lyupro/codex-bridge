/** Regression coverage for Plan_27 scope preflight and explicit new-file declarations. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateScope } from '../../src/home/lib/runner/scope-check.mjs';

const RUN_CODEX = new URL('../../src/home/lib/run-codex.mjs', import.meta.url).href;
const LAUNCHER = new URL('../../src/home/lib/runner/launcher.mjs', import.meta.url).href;
const ARGS_MODULE = new URL('../../src/home/lib/runner/args.mjs', import.meta.url).href;

function fixture(t, suffix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `scope-${suffix}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function repository(t, suffix = 'repo') {
  const root = fixture(t, suffix);
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'existing.mjs'), 'export default 1;\n');
  return { root, repo };
}

function mockedLauncher(source, args, input, env, cwd) {
  const script = `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
${source}
syncBuiltinESMExports();
process.argv = [process.execPath, ${JSON.stringify(LAUNCHER)}, ...${JSON.stringify(args)}];
const { launcher } = await import(${JSON.stringify(LAUNCHER)});
await launcher();
`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd,
    env: { ...process.env, ...env },
    input,
    encoding: 'utf8',
  });
}

const SUCCESS_SOURCE = `
import { EventEmitter } from 'node:events';
const realSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = (command, args, options) =>
  command === 'git' ? realSpawnSync(command, args, options) : { status: 0, error: null, stderr: '', stdout: '' };
childProcess.spawn = () => {
  const worker = new EventEmitter();
  worker.pid = 999999;
  worker.unref = () => {};
  return worker;
};
`;

function buildArgs(repo, orderId, scope = 'src/existing.mjs', extra = []) {
  return [
    '--agent', 'codex-build',
    '--repo', repo,
    '--scope', scope,
    '--slug', 'scope-test',
    '--order-id', orderId,
    ...extra,
  ];
}

function runPath(output) {
  const line = output.stdout.split(/\r?\n/).find((part) => part.startsWith('RUN='));
  assert.ok(line, `launcher did not print a run path:\n${output.stdout}\n${output.stderr}`);
  return line.slice(4).trim();
}

test('scope preflight refuses every structurally impossible spelling', (t) => {
  const { repo } = repository(t, 'structure');
  const cases = [
    { pattern: String.raw`C:\repo\src\existing.mjs`, reason: /absolute|drive/i },
    { pattern: '/absolute/src/existing.mjs', reason: /absolute/i },
    { pattern: String.raw`\\?\C:\repo\src\existing.mjs`, reason: /absolute/i },
    { pattern: String.raw`\\server\share\src\existing.mjs`, reason: /absolute/i },
    { pattern: String.raw`src\existing.mjs`, reason: /backslash/i },
    { pattern: 'src/../src/existing.mjs', reason: /parent|\.\./i },
  ];

  for (const { pattern, reason } of cases) {
    const refusal = validateScope(repo, [pattern], []);
    assert.ok(refusal, `expected refusal for ${pattern}`);
    assert.equal(refusal.pattern, pattern);
    assert.match(refusal.reason, reason);
    assert.match(refusal.action, /path|replace|remove|forward/i);
  }
});

test('scope preflight refuses an empty or unmatched pattern', (t) => {
  const { repo } = repository(t, 'missing');
  for (const pattern of ['', 'src/missing*.mjs']) {
    const refusal = validateScope(repo, [pattern], []);
    assert.ok(refusal, `expected refusal for ${JSON.stringify(pattern)}`);
    assert.equal(refusal.pattern, pattern);
    assert.match(refusal.reason, /does not match any existing path/i);
  }
});

test('scope-new exempts only its path while an ordinary typo still fails', (t) => {
  const { repo } = repository(t, 'new-check');
  assert.equal(
    validateScope(repo, ['src/existing.mjs', 'src/new-file.mjs'], ['src/new-file.mjs']),
    null,
  );

  const refusal = validateScope(repo, ['src/existing.mjs', 'src/typo.mjs'], ['src/new-file.mjs']);
  assert.ok(refusal);
  assert.equal(refusal.pattern, 'src/typo.mjs');
  assert.match(refusal.reason, /does not match any existing path/i);
});

test('launcher refuses an invalid scope before creating the run folder', (t) => {
  const { root, repo } = repository(t, 'launcher-refusal');
  const runsRoot = path.join(root, 'runs');
  const pattern = '/absolute/src/existing.mjs';
  const output = mockedLauncher('', buildArgs(repo, 'invalid-order', pattern), 'invalid scope', {
    CODEX_RUNS_ROOT: runsRoot,
  }, repo);

  assert.equal(output.status, 2, output.stderr);
  assert.match(output.stderr, /--scope pattern/);
  assert.match(output.stderr, /absolute/);
  assert.match(output.stderr, /Action:/);
  assert.match(output.stderr, /quota was not spent/);
  assert.equal(fs.existsSync(runsRoot), false);
});

test('--no-wait exits 4 without launching a missing order', (t) => {
  const { root, repo } = repository(t, 'no-wait-missing');
  const runsRoot = path.join(root, 'runs');
  const output = mockedLauncher(
    SUCCESS_SOURCE,
    buildArgs(repo, 'missing-order', 'src/existing.mjs', ['--no-wait']),
    'inspect a run without starting one',
    { CODEX_RUNS_ROOT: runsRoot },
    repo,
  );

  assert.equal(output.status, 4, `${output.stdout}\n${output.stderr}`);
  assert.equal(output.stderr, '');
  assert.match(output.stdout, /No run exists for order id "missing-order"/);
  assert.doesNotMatch(output.stdout, /^RUN=/m);
  assert.equal(
    fs.readdirSync(runsRoot, { recursive: true }).some((entry) => entry === 'status.json' || entry === 'worker.json'),
    false,
  );
});

test('--no-wait cannot be combined with --continue', (t) => {
  const { root, repo } = repository(t, 'no-wait-continue');
  const runsRoot = path.join(root, 'runs');
  const output = mockedLauncher(
    SUCCESS_SOURCE,
    buildArgs(repo, 'conflicting-order', 'src/existing.mjs', ['--no-wait', '--continue']),
    'continue: previous-run — finish the task',
    { CODEX_RUNS_ROOT: runsRoot },
    repo,
  );

  assert.equal(output.status, 2, output.stderr);
  assert.match(output.stderr, /--no-wait cannot be combined with --continue/);
  assert.equal(fs.existsSync(runsRoot), false);
});

test('an honest scope starts and scope-new is persisted in worker.json', (t) => {
  const { root, repo } = repository(t, 'start');
  const runsRoot = path.join(root, 'runs');
  const output = mockedLauncher(
    SUCCESS_SOURCE,
    buildArgs(repo, 'new-order', 'src/existing.mjs', [
      '--scope-new',
      'src/new-file.mjs,src/another-new-file.mjs',
    ]),
    'start with one new file',
    { CODEX_RUNS_ROOT: runsRoot },
    repo,
  );

  assert.equal(output.status, 0, `${output.stdout}\n${output.stderr}`);
  const runDir = runPath(output);
  const worker = JSON.parse(fs.readFileSync(path.join(runDir, 'worker.json'), 'utf8'));
  assert.deepEqual(worker.scope_new, ['src/new-file.mjs', 'src/another-new-file.mjs']);
  assert.deepEqual(fs.readFileSync(path.join(runDir, 'scope.txt'), 'utf8').trim().split(/\r?\n/), [
    'src/existing.mjs',
    'src/new-file.mjs',
    'src/another-new-file.mjs',
  ]);
});

test('a missing --scope is still refused in args even with --scope-new', () => {
  const script = `
import { parseArgs } from ${JSON.stringify(ARGS_MODULE)};
parseArgs(${JSON.stringify([
    '--agent', 'codex-build',
    '--repo', process.cwd(),
    '--slug', 'missing-scope',
    '--order-id', 'missing-scope-order',
    '--scope-new', 'src/new-file.mjs',
  ])});
`;
  const output = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
  });
  assert.equal(output.status, 2, output.stderr);
  assert.match(output.stderr, /--scope is required/);
});

test('all dispatcher prompts state the scope rule, and only build offers --scope-new', () => {
  const wording = '- Scope patterns are globs relative to the repository root. A pattern that matches nothing there is';
  for (const name of ['codex-scout.md', 'codex-build.md', 'codex-review.md']) {
    const content = fs.readFileSync(new URL(`../../src/agents/${name}`, import.meta.url), 'utf8');
    assert.equal(content.split(/\r?\n/).filter((line) => line === wording).length, 1, name);
    // The flag declares a file the run will create, so it belongs to the only agent that writes.
    // The first Plan_27 pass copied it into all three, promising scout and review a flag their
    // runs cannot use.
    assert.equal(content.includes('--scope-new'), name === 'codex-build.md', name);
  }
});

test('--scope-new is refused for the agents that never create a file', () => {
  for (const agent of ['codex-scout', 'codex-review']) {
    const script = `
import { parseArgs } from ${JSON.stringify(ARGS_MODULE)};
parseArgs(${JSON.stringify([
      '--agent', agent,
      '--repo', process.cwd(),
      '--slug', 'no-new-paths',
      '--order-id', 'no-new-paths-order',
      '--question', 'does the flag reach an agent that cannot use it?',
      '--scope', 'src/**',
      '--scope-new', 'src/new-file.mjs',
    ])});
`;
    const output = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
    });
    assert.equal(output.status, 2, output.stderr);
    assert.match(output.stderr, /--scope-new is only for codex-build/);
  }
});

test('a scout scope is checked too: an impossible pattern never reaches Codex', (t) => {
  const { root, repo } = repository(t, 'scout-scope');
  const runsRoot = path.join(root, 'runs');
  const output = mockedLauncher('', [
    '--agent', 'codex-scout',
    '--repo', repo,
    '--scope', 'srcc/**',
    '--slug', 'scout-scope',
    '--order-id', 'scout-scope-order',
    '--question', 'which module owns the scope check?',
  ], 'scout with a typo in scope', { CODEX_RUNS_ROOT: runsRoot }, repo);

  assert.equal(output.status, 2, output.stderr);
  assert.match(output.stderr, /does not match any existing path/i);
  assert.equal(fs.existsSync(runsRoot), false);
});

test('the file list comes from git, so an ignored path cannot satisfy a pattern', (t) => {
  const { repo } = repository(t, 'git-list');
  const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  git('init');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'build/\n');
  fs.mkdirSync(path.join(repo, 'build'));
  fs.writeFileSync(path.join(repo, 'build', 'generated.mjs'), 'export default 2;\n');

  // Ignored output is not repository content: a scope naming it would describe work the verdict
  // cannot see afterwards. The walk this replaced counted it, and counted node_modules with it.
  const refusal = validateScope(repo, ['build/**'], []);
  assert.ok(refusal, 'an ignored path must not satisfy a scope pattern');
  assert.match(refusal.reason, /does not match any existing path/i);
  // An untracked file still counts: work in progress is repository content, and requiring a commit
  // first would refuse the second pass of every task.
  assert.equal(validateScope(repo, ['src/existing.mjs'], []), null);
});
