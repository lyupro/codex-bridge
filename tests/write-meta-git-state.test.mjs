#!/usr/bin/env node
/**
 * Guards the one axis of collect() that judges the repository rather than the work: the
 * commit and the branch a build run started and ended on.
 *   node --test tests/write-meta-git-state.test.mjs
 *
 * Both checks outrank everything else in resolveStatus(), LIMIT included, so every case
 * here also fixes that ranking. They exist because of real runs: a build run went to commit
 * while the task forbade it and only a read-only `.git` stopped it, and on 2026-08-03 a run
 * left the repository in detached HEAD on the very same commit — invisible to a check that
 * compares commits alone.
 *
 * The rest of collect()'s build/review axis lives in write-meta.test.mjs, its scout axis in
 * write-meta-scout.test.mjs; the split is by subject, and this file's subject is git state.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { collect } from '../src/home/lib/write-meta.mjs';
import { worktreeSnapshot, reviewScope, findFakeDone } from '../src/home/lib/runner/git-state.mjs';
import { compareSnapshots, decodeSnapshot, SNAPSHOT_V2_HEADER } from '../src/home/lib/meta/snapshot-format.mjs';
import { makeTempTree, removeTempTree } from './temp-tree.mjs';
import { buildResult as build, makeRun } from './meta/test-fixtures.mjs';

// --- commit made during the run -------------------------------------------------------

test('a HEAD that moved during the run fails, however clean the report', () => {
  const dir = makeRun({
    result: build([{ file: 'src/a.ts', what: 'change', why: 'task' }]),
    before: '',
    after: 'U\t10\tsrc/a.ts\n',
    headBefore: 'abcdef1234567890\n',
    headAfter: 'fedcba0987654321\n',
  });
  const { meta } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'FAIL');
  assert.match(meta.reason, /commit made despite prohibition/);
});

test('a moved HEAD outranks a LIMIT signal in the same log', () => {
  const dir = makeRun({
    log: 'ERROR: rate limit exceeded for this account\n',
    result: { summary: '', changes: [], report_markdown: '' },
    before: '',
    after: 'U\t10\tsrc/a.ts\n',
    headBefore: 'abcdef1234567890\n',
    headAfter: 'fedcba0987654321\n',
  });
  const { meta } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'FAIL');
  assert.match(meta.reason, /commit made despite prohibition/);
});

test('identical HEAD before and after is not a commit violation', () => {
  const dir = makeRun({
    result: build([{ file: 'src/a.ts', what: 'change', why: 'task' }]),
    before: '',
    after: 'U\t10\tsrc/a.ts\n',
    headBefore: 'abcdef1234567890\n',
    headAfter: 'abcdef1234567890\n',
  });
  const { meta } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'OK');
});

test('missing head-before/after files (an older run) is not a commit violation', () => {
  const dir = makeRun({
    result: build([{ file: 'src/a.ts', what: 'change', why: 'task' }]),
    before: '',
    after: 'U\t10\tsrc/a.ts\n',
  });
  const { meta } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'OK');
});

// --- branch moved during the run ------------------------------------------------------

test('detaching HEAD during the run fails even when the commit is unchanged', () => {
  const dir = makeRun({
    result: build([{ file: 'src/a.ts', what: 'change', why: 'task' }]),
    before: '',
    after: 'U\t10\tsrc/a.ts\n',
    headBefore: 'abcdef1234567890\n',
    headAfter: 'abcdef1234567890\n',
    branchBefore: 'master\n',
    branchAfter: '\n',
  });
  const { meta } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'FAIL');
  assert.match(meta.reason, /detached HEAD/);
});

test('a different branch name fails', () => {
  const dir = makeRun({
    result: build([{ file: 'src/a.ts', what: 'change', why: 'task' }]),
    before: '',
    after: 'U\t10\tsrc/a.ts\n',
    branchBefore: 'master\n',
    branchAfter: 'feature\n',
  });
  const { meta } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'FAIL');
});

test('identical branch names are not a branch violation', () => {
  const dir = makeRun({
    result: build([{ file: 'src/a.ts', what: 'change', why: 'task' }]),
    before: '',
    after: 'U\t10\tsrc/a.ts\n',
    branchBefore: 'master\n',
    branchAfter: 'master\n',
  });
  const { meta } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'OK');
});

test('missing branch-before/after files (an older run) is not a branch violation', () => {
  const dir = makeRun({
    result: build([{ file: 'src/a.ts', what: 'change', why: 'task' }]),
    before: '',
    after: 'U\t10\tsrc/a.ts\n',
  });
  const { meta } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'OK');
});

test('one branch snapshot without the other is not a branch violation', () => {
  // Half a pair proves nothing: a launcher from before this check, or a worker killed before
  // its snapshot, leaves one file missing — and a missing file must not read as detached HEAD.
  for (const half of [{ branchBefore: 'master\n' }, { branchAfter: 'master\n' }]) {
    const dir = makeRun({
      result: build([{ file: 'src/a.ts', what: 'change', why: 'task' }]),
      before: '',
      after: 'U\t10\tsrc/a.ts\n',
      ...half,
    });
    const { meta } = collect(dir, 'codex-build', 0);
    assert.equal(meta.status, 'OK');
  }
});

// Plan_73 D4: exercise the real writer with quoting enabled, not a simulated snapshot.
function repository(t) {
  const repo = makeTempTree('bridge-git-state-snapshot-');
  const keys = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_COUNT', 'CODEX_RUNS_ROOT'];
  const saved = keys.map((key) => [key, process.env[key]]);
  process.env.GIT_CONFIG_GLOBAL = path.join(repo, 'absent-config');
  process.env.GIT_CONFIG_SYSTEM = path.join(repo, 'absent-config');
  delete process.env.GIT_CONFIG_COUNT;
  process.env.CODEX_RUNS_ROOT = path.join(repo, 'runs');
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    removeTempTree(repo);
  });
  const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  const run = (...args) => {
    const result = git(...args);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  run('init', '-q');
  const commit = () => run('-c', 'user.name=Snapshot Test', '-c', 'user.email=snapshot@example.test',
    'commit', '--allow-empty', '-qm', 'fixture baseline');
  commit();
  assert.equal(git('config', '--get', 'core.quotepath').status, 1);
  return { repo, run, commit };
}

test('clean trees encode a v2 header with exactly one final newline', (t) => {
  const { repo } = repository(t);
  const snapshot = worktreeSnapshot(repo);
  assert.equal(snapshot, `${SNAPSHOT_V2_HEADER}\n`);
  assert.deepEqual(decodeSnapshot(snapshot), { ok: true, version: 2, rows: new Map() });
  assert.deepEqual(compareSnapshots(snapshot, worktreeSnapshot(repo)), { ok: true, changed: [] });
});

test('tracked, new untracked and same-size untracked edits name exact Cyrillic paths', (t) => {
  const { repo, run, commit } = repository(t);
  const tracked = 'изменено.md';
  const untracked = 'новый.md';
  fs.writeFileSync(path.join(repo, tracked), 'before\n');
  run('add', '--', tracked);
  commit();
  const clean = worktreeSnapshot(repo);
  fs.appendFileSync(path.join(repo, tracked), 'edited\n');
  const edited = worktreeSnapshot(repo);
  assert.deepEqual(compareSnapshots(clean, edited), { ok: true, changed: [tracked] });
  assert.equal(decodeSnapshot(edited).rows.get(tracked), '1\t0');
  fs.writeFileSync(path.join(repo, untracked), 'before\n');
  const added = worktreeSnapshot(repo);
  assert.deepEqual(compareSnapshots(edited, added), { ok: true, changed: [untracked] });
  const hash = createHash('sha256').update('before\n').digest('hex');
  assert.equal(decodeSnapshot(added).rows.get(untracked), `U\t7:${hash}`);
  fs.writeFileSync(path.join(repo, untracked), 'after!\n');
  assert.equal(fs.statSync(path.join(repo, untracked)).size, 7);
  assert.deepEqual(compareSnapshots(added, worktreeSnapshot(repo)), { ok: true, changed: [untracked] });
});

test('binary tracked files retain the binary numstat state', (t) => {
  const { repo, run, commit } = repository(t);
  const file = 'двоичный.bin';
  fs.writeFileSync(path.join(repo, file), Buffer.from([0, 1]));
  run('add', '--', file);
  commit();
  fs.writeFileSync(path.join(repo, file), Buffer.from([0, 2]));
  assert.equal(decodeSnapshot(worktreeSnapshot(repo)).rows.get(file), '-\t-');
});

for (const [code, state] of [['ENOENT', 'U\tmissing'], ['EBUSY', 'U\tunreadable'], ['EPERM', 'U\tunreadable']]) {
  // A vanished file is `missing`; one held by another process on Windows is `unreadable`, not a crashed run.
  test(`an untracked file whose open fails with ${code} is recorded as ${state.slice(2)}`, (t) => {
    const { repo } = repository(t);
    const full = path.join(repo, 'исчез.md');
    fs.writeFileSync(full, 'content\n');
    const open = fs.openSync;
    t.mock.method(fs, 'openSync', function (name, ...args) {
      if (name === full) throw Object.assign(new Error(`open failed: ${code}`), { code });
      return open.call(this, name, ...args);
    });
    assert.equal(decodeSnapshot(worktreeSnapshot(repo)).rows.get('исчез.md'), state);
  });
}

test('git failures contribute no rows from the failed listing', (t) => {
  const { repo } = repository(t);
  // An unborn repository exercises the real HEAD-diff failure without mocking git.
  const unborn = path.join(repo, 'unborn');
  fs.mkdirSync(unborn);
  assert.equal(spawnSync('git', ['init', '-q', unborn]).status, 0);
  fs.writeFileSync(path.join(unborn, 'новый.md'), 'content\n');
  const decoded = decodeSnapshot(worktreeSnapshot(unborn));
  assert.equal(decoded.ok, true);
  assert.deepEqual([...decoded.rows.keys()], ['новый.md']);
  assert.equal(worktreeSnapshot(path.join(repo, 'absent')), `${SNAPSHOT_V2_HEADER}\n`);
  assert.deepEqual(reviewScope(path.join(repo, 'absent'), 'uncommitted').files, []);
});

test('reviewScope lists both exact names of a staged Cyrillic rename', (t) => {
  const { repo, run, commit } = repository(t);
  const oldName = 'старое.md';
  const newName = 'новое.md';
  fs.writeFileSync(path.join(repo, oldName), 'tracked\n');
  run('add', '--', oldName);
  commit();
  run('mv', '--', oldName, newName);
  assert.deepEqual(reviewScope(repo, 'uncommitted'), {
    label: 'uncommitted changes (staged, unstaged, untracked)',
    diffCommand: 'git status --porcelain && git diff HEAD',
    files: [newName, oldName],
  });
  const changes = compareSnapshots(`${SNAPSHOT_V2_HEADER}\n`, worktreeSnapshot(repo));
  assert.equal(changes.ok, true);
  assert.deepEqual(changes.changed.sort(), [oldName, newName].sort());
});

test('reviewScope keeps commit and base labels while decoding exact names', (t) => {
  const { repo, run, commit } = repository(t);
  const base = run('rev-parse', 'HEAD').trim();
  const file = 'изменено.md';
  fs.writeFileSync(path.join(repo, file), 'tracked\n');
  run('add', '--', file);
  commit();
  const sha = run('rev-parse', 'HEAD').trim();
  assert.deepEqual(reviewScope(repo, `base:${base}`), {
    label: `branch changes against base ${base}`, diffCommand: `git diff ${base}...HEAD`, files: [file],
  });
  assert.deepEqual(reviewScope(repo, `commit:${sha}`), {
    label: `commit ${sha}`, diffCommand: `git show ${sha}`, files: [file],
  });
});

test('findFakeDone flags a placeholder in a new Cyrillic file', (t) => {
  const { repo } = repository(t);
  fs.writeFileSync(path.join(repo, 'проверка.md'), 'TODO: implement\n');
  assert.equal(findFakeDone(repo), 'проверка.md:1: TODO: implement\n');
});

test('decoded Cyrillic run-folder names are excluded from snapshots and untracked scans', (t) => {
  const { repo, run, commit } = repository(t);
  process.env.CODEX_RUNS_ROOT = path.join(repo, 'прогоны');
  fs.mkdirSync(process.env.CODEX_RUNS_ROOT);
  const artifact = path.join(process.env.CODEX_RUNS_ROOT, 'задача.md');
  fs.writeFileSync(artifact, 'before\n');
  run('add', '--', 'прогоны/задача.md');
  commit();
  fs.appendFileSync(artifact, 'TODO: runner artifact\n');
  fs.writeFileSync(path.join(process.env.CODEX_RUNS_ROOT, 'новый.md'), 'TODO: runner artifact\n');
  fs.mkdirSync(path.join(repo, 'прогоны-other'));
  fs.writeFileSync(path.join(repo, 'прогоны-other', 'реальный.md'), 'real work\n');
  assert.deepEqual([...decodeSnapshot(worktreeSnapshot(repo)).rows.keys()], ['прогоны-other/реальный.md']);
  // D4 replaces only the untracked path listing; tracked diff scanning keeps its behavior.
  assert.equal(findFakeDone(repo), '+TODO: runner artifact\n');
});
