import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { before, test } from 'node:test';
import { makeTempTree } from '../temp-tree.mjs';
import { discoverGitRoot, resolveOrderRepository } from '../../src/home/lib/runner/order-repository.mjs';

let tree;
let repoA;
let repoB;
let outside;
let taskFile;
let outsideTask;
let subdir;

function git(dir, args) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')),
  );
  const result = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true, env });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function success(repo, source) {
  return { ok: true, repo: path.resolve(repo), source };
}

before(() => {
  tree = fs.realpathSync(makeTempTree('order-repository-'));
  repoA = path.join(tree, 'repo-A');
  repoB = path.join(tree, 'repo-B');
  outside = path.join(tree, 'outside');
  for (const dir of [repoA, repoB, outside]) fs.mkdirSync(dir);
  for (const repo of [repoA, repoB]) git(repo, ['init', '--quiet']);
  taskFile = path.join(repoA, 'task.md');
  outsideTask = path.join(outside, 'task.md');
  for (const file of [taskFile, outsideTask]) fs.writeFileSync(file, 'Task\n', 'utf8');
  subdir = path.join(repoA, 'subdir');
  fs.mkdirSync(subdir);
});

test('an untracked task file selects its own repository', () => {
  assert.deepEqual(resolveOrderRepository({ taskFile }), success(repoA, 'task-file'));
});

test('OW-073: shell cwd in another repository cannot choose the target', () => {
  const previous = process.cwd();
  try {
    process.chdir(repoB);
    assert.deepEqual(resolveOrderRepository({ taskFile }), success(repoA, 'task-file'));
  } finally {
    process.chdir(previous);
  }
});

test('an equal label confirms the task repository', () => {
  assert.deepEqual(resolveOrderRepository({ taskFile, label: repoA }), success(repoA, 'task-file+label'));
});

test('a label naming a subdirectory confirms the same root', () => {
  assert.deepEqual(resolveOrderRepository({ taskFile, label: subdir }), success(repoA, 'task-file+label'));
});

test('a foreign repository label refuses with both roots', () => {
  assert.deepEqual(resolveOrderRepository({ taskFile, label: repoB }), {
    ok: false,
    violation: 'repository-mismatch',
    values: { taskFileRoot: repoA, labelRepo: repoB },
  });
});

test('a non-git label cannot override a task repository', () => {
  assert.deepEqual(resolveOrderRepository({ taskFile, label: outside }), {
    ok: false,
    violation: 'repository-mismatch',
    values: { taskFileRoot: repoA, labelRepo: outside },
  });
});

test('an ignored task folder still belongs to its worktree', () => {
  fs.writeFileSync(path.join(repoA, '.gitignore'), 'ignored/\n', 'utf8');
  const ignored = path.join(repoA, 'ignored');
  fs.mkdirSync(ignored);
  const file = path.join(ignored, 'task.md');
  fs.writeFileSync(file, 'Task\n', 'utf8');
  assert.equal(git(repoA, ['check-ignore', '--', 'ignored/task.md']), 'ignored/task.md');
  assert.deepEqual(resolveOrderRepository({ taskFile: file }), success(repoA, 'task-file'));
});

test('a task outside git requires a label and names the task', () => {
  assert.deepEqual(resolveOrderRepository({ taskFile: outsideTask }), {
    ok: false,
    violation: 'repository-label-required',
    values: { taskFile: outsideTask },
  });
});

test('a task outside git accepts a git label and returns its root', () => {
  assert.deepEqual(resolveOrderRepository({ taskFile: outsideTask, label: subdir }), success(repoA, 'label'));
  assert.deepEqual(resolveOrderRepository({ taskFile: outsideTask, label: repoA }), success(repoA, 'label'));
});

test('a task outside git keeps explicit non-git directory mode', () => {
  assert.deepEqual(resolveOrderRepository({ taskFile: outsideTask, label: outside }), success(outside, 'label'));
});

test('stdin without a label refuses and names stdin', () => {
  assert.deepEqual(resolveOrderRepository({ taskFile: null }), {
    ok: false,
    violation: 'repository-label-required',
    values: { taskFile: 'stdin' },
  });
});

test('stdin accepts both git and non-git labels', () => {
  assert.deepEqual(resolveOrderRepository({ taskFile: null, label: subdir }), success(repoA, 'label'));
  assert.deepEqual(resolveOrderRepository({ taskFile: null, label: outside }), success(outside, 'label'));
});

test('relative, missing, file, empty and non-string labels are invalid', () => {
  for (const label of ['repo-A', path.join(tree, 'missing'), taskFile, '', null, 42]) {
    assert.deepEqual(resolveOrderRepository({ taskFile, label }), {
      ok: false,
      violation: 'repository-label-invalid',
      values: { label },
    });
  }
});

test('OW-073: inherited GIT_DIR and GIT_WORK_TREE cannot redirect discovery', () => {
  const keys = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_CEILING_DIRECTORIES'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.GIT_DIR = path.join(repoB, '.git');
    process.env.GIT_WORK_TREE = repoB;
    process.env.GIT_COMMON_DIR = path.join(repoB, '.git');
    process.env.GIT_CEILING_DIRECTORIES = repoA;
    assert.deepEqual(resolveOrderRepository({ taskFile }), success(repoA, 'task-file'));
    assert.deepEqual(resolveOrderRepository({ taskFile: null, label: subdir }), success(repoA, 'label'));
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test('task discovery errors are never interpreted as outside git', () => {
  assert.deepEqual(resolveOrderRepository({ taskFile, gitRoot: () => ({ error: 'boom' }) }), {
    ok: false,
    violation: 'repository-discovery-failed',
    values: { error: 'boom' },
  });
});

test('label discovery errors refuse for both stdin and task-file input', () => {
  for (const input of [null, taskFile, outsideTask]) {
    const gitRoot = (dir) => dir === repoB ? { error: 'boom\nsecond line' } : discoverGitRoot(dir);
    assert.deepEqual(resolveOrderRepository({ taskFile: input, label: repoB, gitRoot }), {
      ok: false,
      violation: 'repository-discovery-failed',
      values: { error: 'boom' },
    });
  }
});

test('missing task files and thrown discovery errors refuse without throwing', () => {
  const missing = resolveOrderRepository({ taskFile: path.join(repoA, 'missing.md') });
  assert.equal(missing.ok, false);
  assert.equal(missing.violation, 'repository-discovery-failed');
  assert.match(missing.values.error, /ENOENT/);
  const gitRoot = () => { throw new Error('boom\nsecond line'); };
  for (const input of [taskFile, null]) {
    assert.deepEqual(resolveOrderRepository({ taskFile: input, label: repoA, gitRoot }), {
      ok: false,
      violation: 'repository-discovery-failed',
      values: { error: 'boom' },
    });
  }
});

test('discovery separates non-git directories from invalid directory failures', () => {
  assert.deepEqual(discoverGitRoot(subdir), { root: repoA });
  assert.deepEqual(discoverGitRoot(outside), { outside: true });
  const failure = discoverGitRoot(path.join(tree, 'missing'));
  assert.equal(typeof failure.error, 'string');
  assert.ok(failure.error.length > 0);
  assert.equal(failure.outside, undefined);
  assert.equal(failure.error.includes('\n'), false);
});

test('Windows root identity is case-insensitive without lowercasing the returned repo', () => {
  const labelRoot = process.platform === 'win32' ? repoA.toUpperCase() : path.join(repoA, '.');
  const gitRoot = (dir) => ({ root: dir === repoB ? labelRoot : repoA });
  assert.deepEqual(resolveOrderRepository({ taskFile, label: repoB, gitRoot }), success(repoA, 'task-file+label'));
});

test('a linked worktree selects its own root and rejects the main worktree label', () => {
  git(repoA, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'Initialize fixture']);
  const linked = path.join(tree, 'linked');
  git(repoA, ['worktree', 'add', '--quiet', '--detach', linked, 'HEAD']);
  const linkedTask = path.join(linked, 'task.md');
  fs.writeFileSync(linkedTask, 'Task\n', 'utf8');
  assert.deepEqual(resolveOrderRepository({ taskFile: linkedTask }), success(linked, 'task-file'));
  assert.deepEqual(resolveOrderRepository({ taskFile: linkedTask, label: repoA }), {
    ok: false,
    violation: 'repository-mismatch',
    values: { taskFileRoot: linked, labelRepo: repoA },
  });
});

test('a symlinked task selects the target file repository', (t) => {
  const link = path.join(repoB, 'linked-task.md');
  try {
    fs.symlinkSync(taskFile, link, 'file');
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') {
      t.skip(`Windows symlink permission is unavailable: ${error.message}`);
      return;
    }
    throw error;
  }
  assert.deepEqual(resolveOrderRepository({ taskFile: link }), success(repoA, 'task-file'));
});

test('missing git is a discovery failure rather than outside git', () => {
  const previous = process.env.PATH;
  try {
    process.env.PATH = '';
    const discovery = discoverGitRoot(repoA);
    assert.equal(typeof discovery.error, 'string');
    assert.ok(discovery.error.length > 0);
    assert.equal(discovery.outside, undefined);
    assert.deepEqual(resolveOrderRepository({ taskFile }), {
      ok: false,
      violation: 'repository-discovery-failed',
      values: { error: discovery.error },
    });
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
});
