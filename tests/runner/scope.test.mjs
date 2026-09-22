/** Regression coverage for Plan_27 scope preflight and Plan_58 D7 directory intent. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import { validateScope } from '../../src/home/lib/runner/scope-check.mjs';
import { fixtureTask, launcherProcessMocks } from './launcher-mocks.mjs';

const RUN_CODEX = new URL('../../src/home/lib/run-codex.mjs', import.meta.url).href;
const LAUNCHER = new URL('../../src/home/lib/runner/launcher.mjs', import.meta.url).href;
const ARGS_MODULE = new URL('../../src/home/lib/runner/args.mjs', import.meta.url).href;

function fixture(t, suffix) {
  const root = makeTempTree(`scope-${suffix}-`);
  t.after(() => removeTempTree(root));
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
try {
  const exitCode = await launcher();
  if (exitCode !== undefined) process.exitCode = exitCode;
} catch (err) {
  if (err?.exitCode) process.exitCode = err.exitCode;
  else throw err;
}
`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd,
    env: { ...process.env, ...env },
    input: fixtureTask(args[args.indexOf('--agent') + 1], input),
    encoding: 'utf8',
  });
}

const SUCCESS_SOURCE = launcherProcessMocks({ worker: 'spawn', probe: 'marker' });

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
  return line.slice(4).split(' order-id=', 1)[0].trim();
}

test('scope preflight checks file and directory intent in both scope lists', (t) => {
  const { repo } = repository(t, 'structure');
  const { repo: missingRepo } = repository(t, 'missing-file');
  fs.mkdirSync(path.join(repo, 'muse', 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'muse', 'scripts.mjs'));
  fs.mkdirSync(path.join(repo, 'muse', 'skills'));
  fs.writeFileSync(path.join(repo, 'muse', 'scripts', 'x.mjs'), 'export default 1;\n');
  fs.writeFileSync(path.join(repo, 'muse', 'skills', 'README.md'), 'A skill.\n');
  fs.writeFileSync(path.join(repo, 'muse', 'existing.json'), '{}\n');
  fs.writeFileSync(path.join(repo, 'Makefile'), 'all:\n');
  const directoryReason = /^names a directory rather than a file$/;
  const directoryAction = 'write muse/scripts/** for everything inside it, or name the file itself';
  const newFileAction = 'write Makefile/** if it is a directory, or declare the new file by its own name with an extension; a new extensionless file is declared through its directory';
  const cases = [
    { pattern: String.raw`C:\repo\src\existing.mjs`, refusal: /absolute|drive/i, reason: 'drive paths are not relative' },
    { pattern: '/absolute/src/existing.mjs', refusal: /absolute/i, reason: 'absolute paths cannot match repository paths' },
    { pattern: String.raw`\\?\C:\repo\src\existing.mjs`, refusal: /absolute/i, reason: 'extended paths are absolute' },
    { pattern: String.raw`\\server\share\src\existing.mjs`, refusal: /absolute/i, reason: 'UNC paths are absolute' },
    { pattern: String.raw`src\existing.mjs`, refusal: /backslash/i, reason: 'scope separators must be forward slashes' },
    { pattern: 'src/../src/existing.mjs', refusal: /parent|\.\./i, reason: 'parent segments are forbidden' },
    { pattern: 'muse/scripts', refusal: directoryReason, action: directoryAction, reason: 'an existing directory is not a file' },
    { pattern: 'muse/scripts/', refusal: directoryReason, action: directoryAction, reason: 'a trailing slash names a directory' },
    {
      pattern: 'muse/scripts.mjs', refusal: directoryReason, reason: 'a dot does not make an existing directory a file',
      action: 'write muse/scripts.mjs/** for everything inside it, or name the file itself',
    },
    {
      pattern: 'absent.mjs/', refusal: directoryReason, reason: 'a trailing slash also refuses a missing dotted directory',
      action: 'write absent.mjs/** for everything inside it, or name the file itself',
    },
    { pattern: 'muse/scripts/**', reason: 'a recursive glob includes files inside the directory' },
    { pattern: 'muse/scripts/*.mjs', reason: 'a star glob includes matching files' },
    { pattern: 'muse/scripts/?.mjs', reason: 'a question-mark glob includes matching files' },
    { pattern: 'muse/skills/**', reason: 'existing recursive skill scope stays valid' },
    { pattern: 'muse/*.json', reason: 'existing JSON globs stay valid' },
    { pattern: 'muse/scripts/*/', newFile: true, reason: 'directory rules never judge a glob, even with a trailing slash' },
    { pattern: 'muse/ports.json', newFile: true, reason: 'scope-new permits an absent file with an extension' },
    { pattern: 'Makefile', reason: 'an existing extensionless file is valid' },
    { pattern: 'Makefile', repo: missingRepo, refusal: directoryReason, action: newFileAction, reason: 'an absent extensionless name is ambiguous' },
    { pattern: 'missing-parent/new-file.mjs', newFile: true, reason: 'new files may have a missing parent directory' },
  ];

  for (const { pattern, reason, refusal: expected, action, newFile, repo: caseRepo = repo } of cases) {
    for (const scopeNew of [false, true]) {
      const context = `${scopeNew ? '--scope-new' : '--scope'} ${pattern}: ${reason}`;
      const refusal = validateScope(caseRepo, scopeNew ? [] : [pattern], scopeNew || newFile ? [pattern] : []);
      if (!expected) {
        assert.equal(refusal, null, context);
      } else {
        assert.ok(refusal, context);
        assert.equal(refusal.pattern, pattern, context);
        assert.match(refusal.reason, expected, context);
        if (action) assert.equal(refusal.action, action, context);
        else assert.match(refusal.action, /path|replace|remove|forward/i, context);
      }
    }
    if (newFile) {
      // D7 adds structural checks; it must not waive the declared-only existence requirement.
      const refusal = validateScope(caseRepo, [pattern], []);
      assert.ok(refusal, reason);
      assert.equal(refusal.pattern, pattern);
      assert.match(refusal.reason, /does not match any existing path/i);
    }
  }
});

test('structural refusals in either list precede the declared existence check', (t) => {
  const { repo } = repository(t, 'refusal-order');
  // Plan_58 D7 must explain the directory mistake even when an earlier declared file is missing.
  for (const scopeNew of [false, true]) {
    const refusal = validateScope(repo, ['missing.mjs', ...(scopeNew ? [] : ['src'])], scopeNew ? ['src'] : []);
    assert.equal(refusal.pattern, 'src');
    assert.equal(refusal.reason, 'names a directory rather than a file');
  }
  assert.equal(validateScope(repo, ['src'], ['/absolute/file.mjs']).pattern, 'src');
});

test('scope patterns inside service directories are refused before glob matching', (t) => {
  const { repo } = repository(t, 'service-pattern');
  fs.mkdirSync(path.join(repo, 'docs'));
  fs.writeFileSync(path.join(repo, 'docs', 'guide.md'), 'Guide.\n');
  fs.writeFileSync(path.join(repo, 'docs', '.claude-notes.md'), 'Notes.\n');
  const reason = 'lies inside a service directory that no scope can authorise';
  const action = 'name the file outside the service directory, or make that edit yourself';
  for (const pattern of [
    '.claude/context/architecture.md', '.git/config', 'node_modules/x/index.js',
    '.omx/state/a.json', '.claude/**', '.CLAUDE/x.md',
  ]) {
    assert.deepEqual(validateScope(repo, [pattern], []), { pattern, reason, action });
  }
  assert.deepEqual(validateScope(repo, [], ['.claude/context/architecture.md']), {
    pattern: '.claude/context/architecture.md', reason, action,
  });
  assert.equal(validateScope(repo, ['**/*.md'], []), null);
  assert.equal(validateScope(repo, ['docs/.claude-notes.md'], []), null);
});

test('unreadable or vanished paths fall through to the missing-path spelling rule', (t) => {
  const { repo } = repository(t, 'stat-errors');
  const statSync = fs.statSync;
  let code = 'EACCES';
  t.mock.method(fs, 'statSync', (target, ...args) => {
    if (target === path.join(repo, 'src', 'existing.mjs') || target === path.join(repo, 'src')) {
      throw Object.assign(new Error('path cannot be read'), { code });
    }
    return statSync(target, ...args);
  });
  for (code of ['EACCES', 'ENOENT']) {
    assert.equal(validateScope(repo, ['src/existing.mjs'], []), null, code);
    assert.equal(validateScope(repo, [], ['src/existing.mjs']), null, code);
    for (const scopeNew of [false, true]) {
      const refusal = validateScope(repo, scopeNew ? [] : ['src'], scopeNew ? ['src'] : []);
      assert.equal(refusal.reason, 'names a directory rather than a file', code);
      assert.equal(refusal.action, 'write src/** if it is a directory, or declare the new file by its own name with an extension; a new extensionless file is declared through its directory', code);
    }
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
  assert.match(output.stdout, /^RUN=.* order-id=new-order$/m);
  const runDir = runPath(output);
  const probe = JSON.parse(fs.readFileSync(path.join(runDir, 'status.json'), 'utf8')).sandbox_probe;
  assert.equal(probe.outcome, 'alive');
  assert.equal(probe.attempts.length, 1);
  assert.equal(probe.attempts[0].marker, true);
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
try { parseArgs(${JSON.stringify([
    '--agent', 'codex-build',
    '--repo', process.cwd(),
    '--slug', 'missing-scope',
    '--order-id', 'missing-scope-order',
    '--scope-new', 'src/new-file.mjs',
  ])}); } catch (err) { process.exitCode = err.exitCode || 1; }
`;
  const output = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
  });
  assert.equal(output.status, 2, output.stderr);
  assert.match(output.stderr, /--scope is required/);
});

test('all dispatcher prompts state the scope rule, and only build offers --scope-new', () => {
  const wording = '- Scope patterns are globs relative to the repository root. A pattern that matches nothing there is';
  for (const name of ['codex-scout.md', 'codex-build.md', 'codex-review.md', 'codex-advisor.md']) {
    const content = fs.readFileSync(new URL(`../../src/agents/${name}`, import.meta.url), 'utf8');
    assert.equal(content.split(/\r?\n/).filter((line) => line === wording).length, 1, name);
    // The flag declares a file the run will create, so it belongs to the only agent that writes.
    // The first Plan_27 pass copied it into all three, promising scout and review a flag their
    // runs cannot use.
    assert.equal(content.includes('--scope-new'), name === 'codex-build.md', name);
  }
});

test('--scope-new is refused for the agents that never create a file', () => {
  for (const agent of ['codex-scout', 'codex-review', 'codex-advisor']) {
    const script = `
import { parseArgs } from ${JSON.stringify(ARGS_MODULE)};
try { parseArgs(${JSON.stringify([
      '--agent', agent,
      '--repo', process.cwd(),
      '--slug', 'no-new-paths',
      '--order-id', 'no-new-paths-order',
      '--question', 'does the flag reach an agent that cannot use it?',
      '--scope', 'src/**',
      '--scope-new', 'src/new-file.mjs',
    ])}); } catch (err) { process.exitCode = err.exitCode || 1; }
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
