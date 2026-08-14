#!/usr/bin/env node
/**
 * Guards the write-meta.mjs facade on its build/review axis: collect() resolving a run's
 * status from its artifacts (mismatch, service directories, scope), plus projectFolder()
 * and status.json bookkeeping.
 *   node --test agents/codex-bridge/write-meta.test.mjs
 *
 * Every case here is a run shape that has to keep resolving the same way. The mismatch
 * cases are the two production runs of 2026-07-30 that were green while Codex quarantined
 * `.omx/state/session.json` instead of doing the job; the chain case is 2026-07-31, where
 * a second pass of one task was failed for work its first pass had already finished.
 *
 * collect()'s scout axis (explicit orchestrator questions, coverage against questions.json) lives in
 * write-meta-scout.test.mjs, and its git-state axis (the commit and the branch either side
 * of a build run) in write-meta-git-state.test.mjs — the same facade, split by subject once
 * this file outgrew the 400-line limit.
 * Unit coverage of the modules collect() delegates to lives beside each module instead:
 * meta/paths.test.mjs, meta/chain.test.mjs, meta/run-state.test.mjs, meta/verdict.test.mjs.
 *
 * The import below deliberately names all public exports of write-meta.mjs, not just
 * the ones this file's own tests call — an ESM import fails loudly at load time if the
 * facade stops re-exporting one of them, which is what makes this list itself a standing
 * check that the facade's public surface survives a refactor.
 *
 * run-codex.mjs has its own test file, run-codex.test.mjs: it is a different module, and
 * used to share this file only for convenience, not because the coverage overlapped.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  collect,
  projectFolder,
  exitCodeFor,
  AGENTS,
  globToRegExp,
  outOfScope,
  writeStatus,
  markAbandoned,
  abandonedBranchDrift,
  activeRun,
  writeFailure,
  chainRuns,
  chainBaseline,
  expandDeclared,
  reportVersusWork,
} from '../src/home/lib/write-meta.mjs';
import { buildResult as build, makeChainRoot, makeRun } from './meta/test-fixtures.mjs';

// substanceLength ≈ 227 — clears MIN_SINGLE_SUBSTANCE_CHARS (200), so a scout run below
// clears the bar collect() judges it by, independent of the build mismatch check.
const LONG_PROSE_ANSWER =
  'The module reads the file line by line, parses fields according to the format, and validates ' +
  'values before passing them through the processing pipeline without side effects or needless ' +
  'runtime exceptions. The error contract and dependency call order are described separately.';

test('report matching the tree stays OK', () => {
  const dir = makeRun({
    result: build([{ file: 'src/a.ts', what: 'change', why: 'task' }]),
    before: '1\t0\tsrc/a.ts\n',
    after: '4\t2\tsrc/a.ts\n',
  });
  const { meta } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'OK');
});

test('service-directory work with an untouched tree fails', () => {
  // Run 2026-07-30_172914: snapshots byte-identical, changes[] pointing at .omx/.
  const dir = makeRun({
    result: build([{ file: '.omx/state/session.json', what: 'quarantine', why: 'hook interfered' }]),
    before: '1\t0\tsrc/a.ts\n',
    after: '1\t0\tsrc/a.ts\n',
  });
  const { meta } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'FAIL');
  assert.match(meta.reason, /service directories/);
});

test('service-directory work while the tree moved elsewhere fails', () => {
  // Run 2026-07-30_171926: task files changed, report talks about .omx/ only.
  const dir = makeRun({
    result: build([{ file: '.omx/state/session.json', what: 'quarantine', why: 'hook interfered' }]),
    before: 'U\t5437\tpackages/agent-sdk/src/cost/spend-gateway.ts\n',
    after: 'U\t5566\tpackages/agent-sdk/src/cost/spend-gateway.ts\n',
  });
  const { meta } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'FAIL');
  assert.match(meta.reason, /service directories/);
});

test('declared edits with an untouched tree fail', () => {
  const dir = makeRun({
    result: build([{ file: 'src/a.ts', what: 'change', why: 'task' }]),
    before: '1\t0\tsrc/a.ts\n',
    after: '1\t0\tsrc/a.ts\n',
  });
  const { meta } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'FAIL');
  // The run folder sits on its own with no status.json, so there is no task to look up and
  // no earlier pass to fall back on — both halves of the reason have to be said out loud.
  assert.match(meta.reason, /run did not change the tree/);
  assert.match(meta.reason, /earlier runs of this task do not contain the declared files/);
  // Not an accusation: this shape is explained by how the check works, not by wrong work.
  assert.doesNotMatch(meta.reason, /wrong work was done/);
  assert.equal(meta.carried_from_earlier_run, false);
});

test('declared edits with an untouched tree are OK when an earlier pass made them', () => {
  // Run 2026-07-31_121703: the second pass found its own earlier edits already in place,
  // listed them honestly, changed nothing — and was told it had done no work. Same empty
  // delta as the case above; the only difference is that the chain has the files.
  const root = makeChainRoot([
    { name: 'a-first', at: '2026-07-31T10:00:00Z', before: '', after: 'U\t10\tsrc/a.ts\n' },
    {
      name: 'b-second',
      at: '2026-07-31T12:00:00Z',
      before: 'U\t10\tsrc/a.ts\n',
      after: 'U\t10\tsrc/a.ts\n',
      result: build([{ file: 'src/a.ts', what: 'change', why: 'task' }]),
    },
  ]);
  const { meta, reply } = collect(path.join(root, 'b-second'), 'codex-build', 0);
  assert.equal(meta.status, 'OK');
  assert.equal(meta.carried_from_earlier_run, true);
  assert.match(reply, /changes were made by an earlier run of this task/);
});

test('a changed tree with an empty change list fails', () => {
  const dir = makeRun({
    result: build([]),
    before: '',
    after: 'U\t120\tsrc/new.ts\n',
  });
  const { meta } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'FAIL');
  assert.match(meta.reason, /names no changes/);
});

test('nothing declared and nothing changed is a legitimate OK', () => {
  const dir = makeRun({ result: build([]), before: '2\t1\tsrc/a.ts\n', after: '2\t1\tsrc/a.ts\n' });
  const { meta } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'OK');
});

test('paths match across separators, ./ prefixes and absolute form', () => {
  const dir = makeRun({
    result: build([
      { file: 'C:\\repo\\src\\a.ts', what: 'change', why: 'task' },
      { file: './src/b.ts', what: 'change', why: 'task' },
    ]),
    before: '',
    after: 'U\t10\tsrc/a.ts\n',
  });
  const { meta } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'OK');
});

test('a file restored to its committed state counts as touched', () => {
  const dir = makeRun({
    result: build([{ file: 'src/a.ts', what: 'revert', why: 'task' }]),
    before: '3\t1\tsrc/a.ts\n',
    after: '',
  });
  const { meta } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'OK');
});

test('a red verification still outranks the mismatch check', () => {
  const dir = makeRun({
    result: build([{ file: '.omx/state/session.json', what: 'quarantine', why: 'hook interfered' }], {
      verify_passed: false,
    }),
    before: '',
    after: '',
  });
  const { meta } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'FAIL');
  assert.match(meta.reason, /failed/);
});

test('a quota signal stays LIMIT rather than becoming a mismatch', () => {
  const dir = makeRun({
    log: 'ERROR: rate limit exceeded for this account\n',
    result: { summary: '', changes: [], report_markdown: '' },
    before: '',
    after: 'U\t10\tsrc/a.ts\n',
  });
  const { meta } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'LIMIT');
});

test('a non-zero exit stays FAIL for its own reason', () => {
  const dir = makeRun({
    log: 'ERROR: unexpected shutdown\n',
    result: build([{ file: 'src/a.ts', what: 'change', why: 'task' }]),
    before: '',
    after: 'U\t10\tsrc/a.ts\n',
  });
  const { meta } = collect(dir, 'codex-build', 1);
  assert.equal(meta.status, 'FAIL');
  assert.match(meta.reason, /exit=1/);
});

test('scout is not subject to the build mismatch check', () => {
  // Tree moved (src/a.ts) while the scout report declares no "changes" at all — the shape
  // that fails a build via reportVersusWork(). The answer has to clear the single-question
  // substance bar on its own merits, so a scout run is judged as a scout run, not as a build
  // with a missing report.
  const dir = makeRun({
    result: { answer: LONG_PROSE_ANSWER, findings: [], unknowns: [], report_markdown: '# report' },
    before: '',
    after: 'U\t10\tsrc/a.ts\n',
  });
  const { meta } = collect(dir, 'codex-scout', 0);
  assert.equal(meta.status, 'OK');
});

test('a dotted repo folder does not become a hidden run folder', () => {
  assert.equal(projectFolder('C:/Users/dev/.claude'), 'claude');
  assert.equal(projectFolder('/home/u/.omc'), 'omc');
  assert.equal(projectFolder('C:/repos/site.loc'), 'site.loc');
  assert.equal(projectFolder('C:/repos/...'), 'repo');
});

test('review is not subject to the build mismatch check', () => {
  const dir = makeRun({
    result: { verdict: 'approve', summary: 'ok', findings: [], next_steps: [] },
    file: 'review.json',
  });
  const { meta } = collect(dir, 'codex-review', 0);
  assert.equal(meta.status, 'OK');
});

// --- build scope (scope.txt) ---------------------------------------------------------

test('an edit inside the declared scope is OK', () => {
  const dir = makeRun({
    result: build([{ file: 'packages/agent-sdk/src/x.ts', what: 'change', why: 'task' }]),
    before: '',
    after: 'U\t10\tpackages/agent-sdk/src/x.ts\n',
    scope: 'packages/**\n',
  });
  const { meta } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'OK');
});

test('the build reply preserves the touched path spelling', () => {
  const dir = makeRun({
    result: build([{ file: 'CHANGELOG.md', what: 'change', why: 'task' }]),
    before: '',
    after: 'U\t10\tCHANGELOG.md\n',
    scope: '**\n',
  });
  const { meta, reply } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'OK');
  assert.match(reply, /Files: 1 changed · CHANGELOG\.md/);
});

test('a multi-line verification names its first command whole, not a cut-off one', () => {
  // Collapsed into one 60-character line, three commands came out as
  // `rtk npm test rtk npm run check:s — pass`: a command the operator cannot run or trust.
  const dir = makeRun({
    result: build([{ file: 'a.txt', what: 'change', why: 'task' }], {
      verify_command: 'npm test\nnpm run check:size\ngit status --short',
    }),
    before: '',
    after: 'U\t10\ta.txt\n',
    scope: '**\n',
  });
  const { reply } = collect(dir, 'codex-build', 0);
  assert.match(reply, /Verification: npm test \(\+2 more\) — pass/);
});

test('an extra file outside the scope pattern fails', () => {
  const dir = makeRun({
    result: build([{ file: 'packages/agent-sdk/src/x.ts', what: 'change', why: 'task' }]),
    before: '',
    after: 'U\t10\tpackages/agent-sdk/src/x.ts\nU\t5\t!Plans/Plan_X.md\n',
    scope: 'packages/**\n',
  });
  const { meta } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'FAIL');
  assert.match(meta.reason, /out-of-scope changes/);
  assert.match(meta.reason, /!Plans\/Plan_X\.md/);
});

test('a file the environment wrote during the run is reported, not charged to the run', () => {
  // The 2026-08-02 run: scoped files edited honestly, .omc/project-memory.json rewritten by
  // OMC alongside it. The verdict must not charge the run for it, and the reply must still
  // say it happened — a pattern that silences a path would hide a real edit next time.
  const dir = makeRun({
    result: build([{ file: 'packages/agent-sdk/src/x.ts', what: 'change', why: 'task' }]),
    before: '',
    after: 'U\t10\tpackages/agent-sdk/src/x.ts\nU\t7\t.omc/project-memory.json\n',
    scope: 'packages/**\n',
    envPaths: ['.omc/**'],
  });
  const { meta, reply } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'OK');
  assert.deepEqual(meta.environment_changes, ['.omc/project-memory.json']);
  assert.match(reply, /Files: 1 changed/);
  assert.match(reply, /Environment: 1 changed outside the run — \.omc\/project-memory\.json/);
});

test('without a recorded environment the same tree still fails, as it did before', () => {
  const dir = makeRun({
    result: build([{ file: 'packages/agent-sdk/src/x.ts', what: 'change', why: 'task' }]),
    before: '',
    after: 'U\t10\tpackages/agent-sdk/src/x.ts\nU\t7\t.omc/project-memory.json\n',
    scope: 'packages/**\n',
  });
  const { meta } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'FAIL');
  assert.match(meta.reason, /out-of-scope changes/);
});

test('a pattern that explicitly allows .git/** still fails on a .git edit', () => {
  const dir = makeRun({
    result: build([{ file: '.git/config', what: 'change', why: 'task' }]),
    before: '',
    after: 'U\t10\t.git/config\n',
    scope: '.git/**\n',
  });
  const { meta } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'FAIL');
  assert.match(meta.reason, /out-of-scope changes/);
  assert.match(meta.reason, /\.git\/config/);
});

test('a run with no scope.txt (an older run) is not scope-checked', () => {
  // Same shape as a scope violation — a second, unrelated file changed — but with no
  // scope.txt on disk the check has to stay off, exactly as it behaved before scope existed.
  const dir = makeRun({
    result: build([{ file: 'packages/x.ts', what: 'change', why: 'task' }]),
    before: '',
    after: 'U\t10\tpackages/x.ts\nU\t3\trandom/other.ts\n',
  });
  const { meta } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'OK');
});

test('reportVersusWork finds a renamed run baseline by task hash', () => {
  const taskHash = 'same-task-hash';
  const runsRoot = makeChainRoot([
    {
      name: '2026-08-03_100000_old-name',
      slug: 'old-name',
      taskHash,
      before: '',
      result: build([]),
    },
  ]);
  const dir = makeRun({
    result: build([{ file: 'src/a.ts', what: 'change', why: 'task' }]),
    before: 'U\t10\tsrc/a.ts\n',
    after: 'U\t10\tsrc/a.ts\n',
  });
  const verdict = reportVersusWork(dir, build([{ file: 'src/a.ts', what: 'change', why: 'task' }]), {
    runsRoot,
    repo: '/repo/task',
    slug: 'new-name',
    taskHash,
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.carried, true);
});

// --- collect(): status.json -----------------------------------------------------------

test('collect() moves status.json to finished with the same status as meta.json', () => {
  const dir = makeRun({
    result: build([{ file: 'src/a.ts', what: 'change', why: 'task' }]),
    before: '',
    after: 'U\t10\tsrc/a.ts\n',
  });
  const { meta } = collect(dir, 'codex-build', 0);
  const status = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
  assert.equal(status.state, 'finished');
  assert.equal(status.status, meta.status);
  assert.equal(status.finished_at, meta.finished_at);
});
