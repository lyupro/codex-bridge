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
import { collect } from '../src/home/lib/write-meta.mjs';
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
