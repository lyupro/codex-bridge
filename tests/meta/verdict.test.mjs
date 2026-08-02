#!/usr/bin/env node
/**
 * Guards verdict.mjs: outOfScope and reportVersusWork, called directly.
 *   node --test agents/codex/meta/verdict.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { outOfScope, reportVersusWork } from '../../src/meta/verdict.mjs';
import { makeChainRoot, CHAIN_REPO, CHAIN_SLUG } from './test-fixtures.mjs';

const build = (changes, extra = {}) => ({
  summary: 'done',
  changes,
  verify_command: 'npm test',
  verify_passed: true,
  leftovers: [],
  report_markdown: '# report',
  ...extra,
});

/** The task context reportVersusWork() gets from status.json in production. */
const chainCtx = (runsRoot) => ({ runsRoot, repo: CHAIN_REPO, slug: CHAIN_SLUG });

// --- outOfScope, as a pure function ---------------------------------------------------

test('a backslash path from Codex matches a forward-slash pattern from git', () => {
  const backslashPath = ['src', 'a.ts'].join(String.fromCharCode(92));
  assert.deepEqual(outOfScope([backslashPath], ['src/**']), []);
});

test('outOfScope flags a service directory even when a pattern explicitly allows it', () => {
  assert.deepEqual(outOfScope(['.git/config'], ['.git/**']), ['.git/config']);
});

// --- reportVersusWork, called directly ------------------------------------------------

test('reportVersusWork agrees when the declared file is in this run own delta', () => {
  const root = makeChainRoot([
    { name: 'only', at: '2026-07-31T10:00:00Z', before: '', after: 'U\t10\tsrc/a.ts\n' },
  ]);
  const verdict = reportVersusWork(
    path.join(root, 'only'),
    build([{ file: 'src/a.ts', what: 'change', why: 'task' }]),
    chainCtx(root),
  );
  assert.deepEqual(verdict, { ok: true, carried: false, reason: null });
});

test('reportVersusWork carries work an earlier pass of the same task already did', () => {
  const root = makeChainRoot([
    { name: 'a-first', at: '2026-07-31T10:00:00Z', before: '', after: 'U\t10\tsrc/a.ts\n' },
    { name: 'b-second', at: '2026-07-31T12:00:00Z', before: 'U\t10\tsrc/a.ts\n', after: 'U\t10\tsrc/a.ts\n' },
  ]);
  const verdict = reportVersusWork(
    path.join(root, 'b-second'),
    build([{ file: 'src/a.ts', what: 'change', why: 'task' }]),
    chainCtx(root),
  );
  assert.deepEqual(verdict, { ok: true, carried: true, reason: null });
});

test('a service-directory claim fails even where the chain would vouch for the same shape', () => {
  // Identical fixture either way, so the only thing measured is that the service check is
  // asked before the chain is: no earlier pass of any task grants the right to edit
  // `.claude/`, and finding such a path in the chain would excuse the one thing that cannot be.
  const shape = (file) => {
    const root = makeChainRoot([
      { name: 'a-first', at: '2026-07-31T10:00:00Z', before: '', after: `U\t10\t${file}\n` },
      { name: 'b-second', at: '2026-07-31T12:00:00Z', before: `U\t10\t${file}\n`, after: `U\t10\t${file}\n` },
    ]);
    return reportVersusWork(
      path.join(root, 'b-second'),
      build([{ file, what: 'change', why: 'task' }]),
      chainCtx(root),
    );
  };

  assert.deepEqual(shape('src/a.ts'), { ok: true, carried: true, reason: null });

  const service = shape('.claude/settings.json');
  assert.equal(service.ok, false);
  assert.match(service.reason, /service directories/);
});

test('reportVersusWork names both sides when neither matches the other', () => {
  const root = makeChainRoot([
    { name: 'only', at: '2026-07-31T10:00:00Z', before: '', after: 'U\t10\tsrc/b.ts\n' },
  ]);
  const verdict = reportVersusWork(
    path.join(root, 'only'),
    build([{ file: 'src/a.ts', what: 'change', why: 'task' }]),
    chainCtx(root),
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.carried, false);
  assert.match(verdict.reason, /report names src\/a\.ts, but src\/b\.ts changed/);
});

test('a file the tooling wrote during the run is not work the report owes an entry for', () => {
  // The 2026-08-02 run: three scoped files edited, and .omc/project-memory.json rewritten by
  // OMC while Codex worked. Same fixture twice — the only difference is whether the run
  // recorded what the environment writes.
  const shape = (envPaths) => {
    const root = makeChainRoot([
      {
        name: 'only',
        at: '2026-08-02T00:20:00Z',
        envPaths,
        before: '',
        after: 'U\t10\t.omc/project-memory.json\n',
      },
    ]);
    return reportVersusWork(path.join(root, 'only'), build([]), chainCtx(root));
  };

  assert.deepEqual(shape(['.omc/**']), { ok: true, carried: false, reason: null });

  const unrecorded = shape(undefined);
  assert.equal(unrecorded.ok, false);
  assert.match(unrecorded.reason, /names no changes/);
});

test('reportVersusWork fails a changed tree the report never mentions', () => {
  const root = makeChainRoot([
    { name: 'only', at: '2026-07-31T10:00:00Z', before: '', after: 'U\t120\tsrc/new.ts\n' },
  ]);
  const verdict = reportVersusWork(path.join(root, 'only'), build([]), chainCtx(root));
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /names no changes/);
});
