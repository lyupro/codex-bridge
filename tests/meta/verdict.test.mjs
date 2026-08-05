#!/usr/bin/env node
/**
 * Guards verdict.mjs: outOfScope and reportVersusWork, called directly.
 *   node --test agents/codex/meta/verdict.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { collect } from '../../src/write-meta.mjs';
import { outOfScope, reportVersusWork } from '../../src/meta/verdict.mjs';
import { makeChainRoot, makeRun, CHAIN_REPO, CHAIN_SLUG } from './test-fixtures.mjs';

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

test('declared paths match touched paths without regard to case', () => {
  const root = makeChainRoot([
    { name: 'only', at: '2026-07-31T10:00:00Z', before: '', after: 'U\t10\tCHANGELOG.md\n' },
  ]);
  const verdict = reportVersusWork(
    path.join(root, 'only'),
    build([{ file: 'changelog.md', what: 'change', why: 'task' }]),
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

// The incident behind Plan_15: the quota line came from this package's own test fixtures,
// which a run had printed into raw.log while grepping the repository.
const QUOTA = 'ERROR: rate limit exceeded for this account\n';
const emptyBuild = { summary: '', changes: [], report_markdown: '' };

test('a quoted quota error in raw.log is not a LIMIT when stderr.log exists', () => {
  const dir = makeRun({
    log: `grep output: "${QUOTA.trim()}"\n`,
    stderr: '',
    result: emptyBuild,
  });
  const { meta } = collect(dir, 'codex-build', 1);
  assert.equal(meta.status, 'FAIL');
});

// The other half of the same rule: narrowing the search must not cost LIMIT its real cases,
// or the runner would answer FAIL to a wall it cannot push and the orchestrator would retry.
test('a quota error on the transport stream is still a LIMIT', () => {
  const dir = makeRun({ log: 'reading files\n', stderr: QUOTA, result: emptyBuild });
  const { meta } = collect(dir, 'codex-build', 1);
  assert.equal(meta.status, 'LIMIT');
  assert.match(meta.reason, /rate limit/);
});

test('a deadline verdict outranks quota text in both logs', () => {
  const dir = makeRun({
    log: QUOTA,
    stderr: QUOTA,
    status: { stopped_on_deadline: true, elapsed_ms: 60012 },
    result: emptyBuild,
  });
  const { meta } = collect(dir, 'codex-build', 1);
  assert.equal(meta.status, 'FAIL');
  assert.match(meta.reason, /deadline after 60012 ms/);
  assert.doesNotMatch(meta.reason, /rate limit/);
});

test('an archived run without stderr.log keeps the raw.log quota verdict', () => {
  const dir = makeRun({ log: QUOTA, result: emptyBuild });
  const { meta } = collect(dir, 'codex-build', 1);
  assert.equal(meta.status, 'LIMIT');
});

// Existence is the contract marker, never size: a run whose stderr stayed silent is a new
// run with nothing to report, not an old run to be judged by its stdout.
test('an empty stderr.log is a silent new run, not an archived run', () => {
  const dir = makeRun({ log: QUOTA, stderr: '', result: emptyBuild });
  const { meta } = collect(dir, 'codex-build', 1);
  assert.equal(meta.status, 'FAIL');
});

// The archived-run fallback is the one way this fix can be undone from the outside: a NEW run
// that lost its stderr.log would be judged by raw.log again, quietly. status.json proves which
// contract the run ran under, so the two artifacts have to agree or neither is believed.
test('a new run missing its stderr.log is a failure, not an archived run', () => {
  const dir = makeRun({
    log: QUOTA,
    status: { stopped_on_deadline: false, elapsed_ms: 4200 },
    result: emptyBuild,
  });
  const { meta } = collect(dir, 'codex-build', 1);
  assert.equal(meta.status, 'FAIL');
  assert.match(meta.reason, /artifacts disagree/);
});
