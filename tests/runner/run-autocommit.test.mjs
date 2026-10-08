/** Guards Plan_77 D1/D5 against committing records into another project's repository. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeTempTree } from '../temp-tree.mjs';
import { commitRunRecord } from '../../src/home/lib/runner/run-autocommit.mjs';

function git(cwd, args) {
  return spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 120_000,
  });
}

function checkedGit(cwd, ...args) {
  const result = git(cwd, args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

// Like withHomeRepo in run-codex.test.mjs, fixtures never inherit the operator's Git config.
function withFixture(body) {
  const root = makeTempTree('run-autocommit-');
  const keys = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM'];
  const saved = keys.map((key) => [key, process.env[key]]);
  for (const key of keys) process.env[key] = path.join(root, 'no-such-gitconfig');
  try {
    return body(root);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function initRepo(root) {
  fs.mkdirSync(root, { recursive: true });
  checkedGit(root, 'init', '-q');
  checkedGit(root, 'config', 'user.name', 'Run fixture');
  checkedGit(root, 'config', 'user.email', 'run-fixture@example.com');
  checkedGit(root, 'config', 'core.quotepath', 'false');
}

function makeRun(storeRoot, { marker = true, status = 'OK', project = 'project', run = 'finished-run' } = {}) {
  const projectDir = path.join(storeRoot, project);
  const runDir = path.join(projectDir, run);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify({ status }));
  fs.writeFileSync(path.join(runDir, 'reply.txt'), 'finished\n');
  fs.writeFileSync(path.join(runDir, 'stderr.log'), '');
  if (marker) fs.writeFileSync(path.join(projectDir, '.project.json'), '{}\n');
  return runDir;
}

test('the store repository commits the run and marker with its verdict, then is unchanged', () => {
  withFixture((root) => {
    initRepo(root);
    const runDir = makeRun(root, { project: 'project with spaces', run: 'finished-ä', status: 'FAIL' });
    assert.deepEqual(commitRunRecord({ runDir, brandRoot: path.join(root, 'elsewhere') }),
      { committed: true, reason: 'committed' });
    assert.equal(checkedGit(root, 'log', '-1', '--format=%s'), 'project with spaces/finished-ä: FAIL');
    assert.equal(checkedGit(root, 'status', '--porcelain'), '');
    assert.deepEqual(checkedGit(root, 'show', '--format=', '--name-only', 'HEAD').split('\n').sort(), [
      'project with spaces/.project.json', 'project with spaces/finished-ä/meta.json',
      'project with spaces/finished-ä/reply.txt', 'project with spaces/finished-ä/stderr.log',
    ]);
    const head = checkedGit(root, 'rev-parse', 'HEAD');
    assert.deepEqual(commitRunRecord({ runDir, brandRoot: root }),
      { committed: false, reason: 'nothing to commit' });
    assert.equal(checkedGit(root, 'rev-parse', 'HEAD'), head);
    assert.equal(fs.readFileSync(path.join(runDir, 'stderr.log'), 'utf8'), '');
  });
});

test('unrelated staged entries stay staged and uncommitted, including partially staged edits', () => {
  withFixture((root) => {
    initRepo(root);
    fs.writeFileSync(path.join(root, 'operator.txt'), 'base\n');
    checkedGit(root, 'add', '--', 'operator.txt');
    checkedGit(root, 'commit', '-q', '-m', 'base');
    fs.writeFileSync(path.join(root, 'operator.txt'), 'staged\n');
    fs.writeFileSync(path.join(root, 'new.txt'), 'staged new file\n');
    checkedGit(root, 'add', '--', 'operator.txt', 'new.txt');
    fs.writeFileSync(path.join(root, 'operator.txt'), 'unstaged\n');
    const indexBefore = checkedGit(root, 'ls-files', '--stage', '--', 'operator.txt', 'new.txt');
    const runDir = makeRun(root);
    const otherRun = makeRun(root, { project: 'other-project' });
    assert.equal(commitRunRecord({ runDir, brandRoot: root }).committed, true);
    assert.equal(checkedGit(root, 'ls-files', '--stage', '--', 'operator.txt', 'new.txt'), indexBefore);
    assert.equal(checkedGit(root, 'show', 'HEAD:operator.txt'), 'base');
    assert.notEqual(git(root, ['cat-file', '-e', 'HEAD:new.txt']).status, 0);
    assert.equal(checkedGit(root, 'status', '--porcelain', '--', 'project'), '');
    assert.equal(checkedGit(root, 'diff', '--cached', '--name-only'), 'new.txt\noperator.txt');
    assert.match(checkedGit(root, 'status', '--porcelain'), /MM operator\.txt/);
    assert.match(checkedGit(root, 'status', '--porcelain'), /\?\? other-project\//);
    assert.equal(fs.readFileSync(path.join(otherRun, 'stderr.log'), 'utf8'), '');
  });
});

test('a brand-home repository commits its runs store', () => {
  withFixture((root) => {
    initRepo(root);
    const runDir = makeRun(path.join(root, 'runs'));
    assert.equal(commitRunRecord({ runDir, brandRoot: root }).committed, true);
    assert.equal(checkedGit(root, 'log', '-1', '--format=%s'), 'project/finished-run: OK');
    assert.equal(checkedGit(root, 'status', '--porcelain'), '');
    assert.match(checkedGit(root, 'show', '--format=', '--name-only', 'HEAD'), /runs\/project\/\.project\.json/);
  });
});

test('a store in the old larger repository is refused without staging anything', () => {
  withFixture((root) => {
    initRepo(root);
    const runDir = makeRun(path.join(root, '.claude', 'codex-runs'));
    assert.deepEqual(commitRunRecord({ runDir, brandRoot: path.join(root, '.lyupro', '.codex-bridge') }),
      { committed: false, reason: 'repository is not the run store' });
    assert.equal(checkedGit(root, 'diff', '--cached', '--name-only'), '');
    assert.equal(fs.readFileSync(path.join(runDir, 'stderr.log'), 'utf8'), '');
  });
});

test('a non-repository store is a quiet refusal', () => {
  withFixture((root) => {
    const runDir = makeRun(root);
    assert.deepEqual(commitRunRecord({ runDir, brandRoot: root }), { committed: false, reason: 'not in git' });
    assert.equal(fs.readFileSync(path.join(runDir, 'stderr.log'), 'utf8'), '');
  });
});

test('brand-home containment uses a directory boundary, not a shared name prefix', () => {
  withFixture((root) => {
    const brandRoot = path.join(root, 'home');
    const runDir = makeRun(path.join(root, 'home-other', 'runs'));
    const calls = [];
    const injected = (cwd, args) => {
      calls.push(args);
      return { status: 0, stdout: brandRoot, stderr: '' };
    };
    assert.deepEqual(commitRunRecord({ runDir, brandRoot, git: injected }),
      { committed: false, reason: 'repository is not the run store' });
    assert.deepEqual(calls, [['rev-parse', '--show-toplevel']]);
  });
});

test('each locked Git step retries twice and never removes the lock', () => {
  withFixture((root) => {
    initRepo(root);
    for (const lockedStep of ['rev-parse', 'add', 'diff', 'commit']) {
      const runDir = makeRun(root, { run: 'run-' + lockedStep });
      const lock = path.join(root, '.git', 'index.lock');
      fs.writeFileSync(lock, 'operator owns this lock\n');
      const waits = [];
      let failures = 0;
      const injected = (cwd, args) => {
        if (args[0] === lockedStep && failures < 2) {
          failures += 1;
          return { status: 128, stdout: '', stderr: 'fatal: index.lock exists\nsecond line' };
        }
        // Successful steps are injected too: the sentinel lock remains owned by the operator.
        return { status: args[0] === 'diff' ? 1 : 0, stdout: args[0] === 'rev-parse' ? root : '', stderr: '' };
      };
      assert.deepEqual(commitRunRecord({ runDir, brandRoot: root, git: injected, waitMs: 17,
        sleep: (ms) => {
          assert.equal(fs.readFileSync(lock, 'utf8'), 'operator owns this lock\n');
          waits.push(ms);
        } }), { committed: true, reason: 'committed' });
      assert.deepEqual(waits, [17, 17]);
      assert.equal(fs.readFileSync(lock, 'utf8'), 'operator owns this lock\n');
    }
  });
});

test('lock exhaustion is bounded and appends exactly one failure line', () => {
  withFixture((root) => {
    const runDir = makeRun(root);
    const calls = [];
    const waits = [];
    const injected = (cwd, args) => {
      calls.push(args[0]);
      return args[0] === 'rev-parse' ? { status: 0, stdout: root, stderr: '' }
        : { status: 128, stderr: 'fatal: index.lock exists\nmore detail' };
    };
    assert.deepEqual(commitRunRecord({ runDir, brandRoot: root, git: injected,
      attempts: 3, waitMs: 5, sleep: (ms) => waits.push(ms) }),
    { committed: false, reason: 'git add failed (exit 128): fatal: index.lock exists' });
    assert.deepEqual(calls, ['rev-parse', 'add', 'add', 'add']);
    assert.deepEqual(waits, [5, 5]);
    assert.equal(fs.readFileSync(path.join(runDir, 'stderr.log'), 'utf8'),
      'autocommit: git add failed (exit 128): fatal: index.lock exists\n');
  });
});

test('a failing repository hook runs normally and logs one commit failure without throwing', () => {
  withFixture((root) => {
    initRepo(root);
    const runDir = makeRun(root);
    const hook = path.join(root, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hook, '#!/bin/sh\nprintf "operator hook refused\\nmore detail\\n" >&2\nexit 1\n', { mode: 0o755 });
    const result = commitRunRecord({ runDir, brandRoot: root });
    assert.deepEqual(result, { committed: false, reason: 'git commit failed (exit 1): operator hook refused' });
    assert.equal(fs.readFileSync(path.join(runDir, 'stderr.log'), 'utf8'), 'autocommit: ' + result.reason + '\n');
    assert.notEqual(git(root, ['rev-parse', '--verify', 'HEAD']).status, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, 'meta.json'), 'utf8')).status, 'OK');
    assert.equal(fs.readFileSync(path.join(runDir, 'reply.txt'), 'utf8'), 'finished\n');
  });
});

test('unreadable metadata uses unknown and a missing marker does not prevent committing', () => {
  withFixture((root) => {
    initRepo(root);
    const runDir = makeRun(root, { marker: false });
    fs.writeFileSync(path.join(runDir, 'meta.json'), 'not JSON');
    assert.equal(commitRunRecord({ runDir, brandRoot: root }).committed, true);
    assert.equal(checkedGit(root, 'log', '-1', '--format=%s'), 'project/finished-run: unknown');
    assert.equal(checkedGit(root, 'status', '--porcelain'), '');
  });
});

test('BOM-prefixed verdict metadata is read through the shared JSON reader', () => {
  withFixture((root) => {
    initRepo(root);
    const runDir = makeRun(root);
    fs.writeFileSync(path.join(runDir, 'meta.json'), '\uFEFF{"status":"LIMIT"}');
    assert.equal(commitRunRecord({ runDir, brandRoot: root }).committed, true);
    assert.equal(checkedGit(root, 'log', '-1', '--format=%s'), 'project/finished-run: LIMIT');
  });
});

test('Git exceptions, timeout errors and unwritable diagnostics never escape', () => {
  withFixture((root) => {
    const runDir = makeRun(root);
    for (const result of [
      { status: null, stderr: '', error: new Error('spawn timed out') },
      { status: 128, stderr: 'fatal: invalid repository\nsecond line' },
    ]) {
      const outcome = commitRunRecord({ runDir, brandRoot: root, git: () => result });
      assert.equal(outcome.committed, false);
      assert.match(outcome.reason, /^git rev-parse failed/);
    }
    const outcome = commitRunRecord({ runDir: path.join(root, 'missing', 'run'), brandRoot: root,
      git: () => { throw new Error('Git unavailable'); } });
    assert.deepEqual(outcome, { committed: false, reason: 'git rev-parse failed (exit unknown): Git unavailable' });
    assert.equal(commitRunRecord({}).committed, false);
    assert.equal(commitRunRecord().committed, false);
  });
});

test('both worker replies precede autocommit and process exit (Plan_77 B6 ordering)', () => {
  const source = fs.readFileSync(new URL('../../src/home/lib/runner/worker.mjs', import.meta.url), 'utf8');
  assert.equal([...source.matchAll(/emitReply\(reply\);/g)].length, 2);
  assert.equal([...source.matchAll(/commitRunRecord\(\{ runDir \}\);/g)].length, 2);
  for (const reply of source.matchAll(/emitReply\(reply\);/g)) {
    const tail = source.slice(reply.index + reply[0].length);
    assert.match(tail, /^\s*\/\/[^\n]*\n\s*commitRunRecord\(\{ runDir \}\);/);
    assert.ok(tail.indexOf('commitRunRecord({ runDir });') < tail.indexOf('process.exit('));
  }
});

test('an exhausted diff lock is a failure even with the normal dirty-diff exit code', () => {
  withFixture((root) => {
    const runDir = makeRun(root);
    const calls = [];
    const result = commitRunRecord({ runDir, brandRoot: root, attempts: 2, sleep: () => {},
      git: (cwd, args) => {
        calls.push(args[0]);
        return args[0] === 'diff' ? { status: 1, stderr: 'fatal: index.lock exists' }
          : { status: 0, stdout: root, stderr: '' };
      } });
    assert.deepEqual(result, { committed: false, reason: 'git diff failed (exit 1): fatal: index.lock exists' });
    assert.deepEqual(calls, ['rev-parse', 'add', 'diff', 'diff']);
    assert.equal(fs.readFileSync(path.join(runDir, 'stderr.log'), 'utf8'), 'autocommit: ' + result.reason + '\n');
  });
});

test('the default brand home and synchronous sleep work with the real Git adapter', () => {
  withFixture((root) => {
    initRepo(root);
    const runDir = makeRun(path.join(root, 'runs'));
    const saved = process.env.CODEX_BRIDGE_HOME;
    process.env.CODEX_BRIDGE_HOME = root;
    let calls = 0;
    try {
      const result = commitRunRecord({ runDir, waitMs: 1, git: (cwd, args) => {
        if (args[0] === 'add' && calls++ === 0) {
          return { status: 128, stderr: 'fatal: index.lock exists' };
        }
        return git(cwd, args);
      } });
      assert.deepEqual(result, { committed: true, reason: 'committed' });
      assert.equal(calls, 2);
      assert.equal(checkedGit(root, 'status', '--porcelain'), '');
    } finally {
      if (saved === undefined) delete process.env.CODEX_BRIDGE_HOME;
      else process.env.CODEX_BRIDGE_HOME = saved;
    }
  });
});