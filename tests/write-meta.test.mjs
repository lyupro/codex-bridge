#!/usr/bin/env node
/**
 * Guards the write-meta.mjs facade on its build/review axis: collect() resolving a run's
 * status from its artifacts (mismatch, service directories, scope, a commit made mid-run),
 * plus projectFolder() and status.json bookkeeping.
 *   node --test agents/codex/write-meta.test.mjs
 *
 * Every case here is a run shape that has to keep resolving the same way. The mismatch
 * cases are the two production runs of 2026-07-30 that were green while Codex quarantined
 * `.omx/state/session.json` instead of doing the job; the chain case is 2026-07-31, where
 * a second pass of one task was failed for work its first pass had already finished.
 *
 * collect()'s scout axis (parseQuestions, coverage against questions.json) lives in
 * write-meta-scout.test.mjs — the same facade, split from this file purely on line count.
 * Unit coverage of the modules collect() delegates to lives beside each module instead:
 * meta/paths.test.mjs, meta/chain.test.mjs, meta/run-state.test.mjs, meta/verdict.test.mjs.
 *
 * The import below deliberately names all 15 public exports of write-meta.mjs, not just
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
  parseQuestions,
  exitCodeFor,
  AGENTS,
  globToRegExp,
  outOfScope,
  writeStatus,
  markAbandoned,
  activeRun,
  writeFailure,
  chainRuns,
  chainBaseline,
  expandDeclared,
  reportVersusWork,
} from '../src/write-meta.mjs';
import { makeChainRoot, makeRun } from './meta/test-fixtures.mjs';

// substanceLength ≈ 227 — clears MIN_SINGLE_SUBSTANCE_CHARS (200), so a scout run below
// clears the bar collect() judges it by, independent of the build mismatch check.
const LONG_PROSE_ANSWER =
  'Модуль читает файл построчно, разбирает поля по формату и проверяет корректность значений, прежде чем передать их дальше по конвейеру обработки данных без побочных эффектов и лишних исключений в рантайме. Отдельно описан контракт ошибок и порядок вызова зависимостей.';

const build = (changes, extra = {}) => ({
  summary: 'сделано',
  changes,
  verify_command: 'npm test',
  verify_passed: true,
  leftovers: [],
  report_markdown: '# отчёт',
  ...extra,
});

test('report matching the tree stays OK', () => {
  const dir = makeRun({
    result: build([{ file: 'src/a.ts', what: 'правка', why: 'задача' }]),
    before: '1\t0\tsrc/a.ts\n',
    after: '4\t2\tsrc/a.ts\n',
  });
  const { meta } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'OK');
});

test('service-directory work with an untouched tree fails', () => {
  // Run 2026-07-30_172914: snapshots byte-identical, changes[] pointing at .omx/.
  const dir = makeRun({
    result: build([{ file: '.omx/state/session.json', what: 'карантин', why: 'мешал хук' }]),
    before: '1\t0\tsrc/a.ts\n',
    after: '1\t0\tsrc/a.ts\n',
  });
  const { meta } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'FAIL');
  assert.match(meta.reason, /служебных каталогах/);
});

test('service-directory work while the tree moved elsewhere fails', () => {
  // Run 2026-07-30_171926: task files changed, report talks about .omx/ only.
  const dir = makeRun({
    result: build([{ file: '.omx/state/session.json', what: 'карантин', why: 'мешал хук' }]),
    before: 'U\t5437\tpackages/agent-sdk/src/cost/spend-gateway.ts\n',
    after: 'U\t5566\tpackages/agent-sdk/src/cost/spend-gateway.ts\n',
  });
  const { meta } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'FAIL');
  assert.match(meta.reason, /служебных каталогах/);
});

test('declared edits with an untouched tree fail', () => {
  const dir = makeRun({
    result: build([{ file: 'src/a.ts', what: 'правка', why: 'задача' }]),
    before: '1\t0\tsrc/a.ts\n',
    after: '1\t0\tsrc/a.ts\n',
  });
  const { meta } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'FAIL');
  // The run folder sits on its own with no status.json, so there is no task to look up and
  // no earlier pass to fall back on — both halves of the reason have to be said out loud.
  assert.match(meta.reason, /прогон дерева не менял/);
  assert.match(meta.reason, /в предыдущих заходах этой задачи заявленных файлов тоже нет/);
  // Not an accusation: this shape is explained by how the check works, not by wrong work.
  assert.doesNotMatch(meta.reason, /сделана не та работа/);
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
      result: build([{ file: 'src/a.ts', what: 'правка', why: 'задача' }]),
    },
  ]);
  const { meta, reply } = collect(path.join(root, 'b-second'), 'codex-build', 0);
  assert.equal(meta.status, 'OK');
  assert.equal(meta.carried_from_earlier_run, true);
  assert.match(reply, /правки сделаны предыдущим заходом этой задачи/);
});

test('a changed tree with an empty change list fails', () => {
  const dir = makeRun({
    result: build([]),
    before: '',
    after: 'U\t120\tsrc/new.ts\n',
  });
  const { meta } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'FAIL');
  assert.match(meta.reason, /не называет ни одной правки/);
});

test('nothing declared and nothing changed is a legitimate OK', () => {
  const dir = makeRun({ result: build([]), before: '2\t1\tsrc/a.ts\n', after: '2\t1\tsrc/a.ts\n' });
  const { meta } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'OK');
});

test('paths match across separators, ./ prefixes and absolute form', () => {
  const dir = makeRun({
    result: build([
      { file: 'C:\\repo\\src\\a.ts', what: 'правка', why: 'задача' },
      { file: './src/b.ts', what: 'правка', why: 'задача' },
    ]),
    before: '',
    after: 'U\t10\tsrc/a.ts\n',
  });
  const { meta } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'OK');
});

test('a file restored to its committed state counts as touched', () => {
  const dir = makeRun({
    result: build([{ file: 'src/a.ts', what: 'откат', why: 'задача' }]),
    before: '3\t1\tsrc/a.ts\n',
    after: '',
  });
  const { meta } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'OK');
});

test('a red verification still outranks the mismatch check', () => {
  const dir = makeRun({
    result: build([{ file: '.omx/state/session.json', what: 'карантин', why: 'мешал хук' }], {
      verify_passed: false,
    }),
    before: '',
    after: '',
  });
  const { meta } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'FAIL');
  assert.match(meta.reason, /не прошла/);
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
    result: build([{ file: 'src/a.ts', what: 'правка', why: 'задача' }]),
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
    result: { answer: LONG_PROSE_ANSWER, findings: [], unknowns: [], report_markdown: '# отчёт' },
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
    result: { verdict: 'approve', summary: 'ок', findings: [], next_steps: [] },
    file: 'review.json',
  });
  const { meta } = collect(dir, 'codex-review', 0);
  assert.equal(meta.status, 'OK');
});

// --- build scope (scope.txt) ---------------------------------------------------------

test('an edit inside the declared scope is OK', () => {
  const dir = makeRun({
    result: build([{ file: 'packages/agent-sdk/src/x.ts', what: 'правка', why: 'задача' }]),
    before: '',
    after: 'U\t10\tpackages/agent-sdk/src/x.ts\n',
    scope: 'packages/**\n',
  });
  const { meta } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'OK');
});

test('an extra file outside the scope pattern fails', () => {
  const dir = makeRun({
    result: build([{ file: 'packages/agent-sdk/src/x.ts', what: 'правка', why: 'задача' }]),
    before: '',
    after: 'U\t10\tpackages/agent-sdk/src/x.ts\nU\t5\t!Plans/Plan_X.md\n',
    scope: 'packages/**\n',
  });
  const { meta } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'FAIL');
  assert.match(meta.reason, /правки вне объёма/);
  assert.match(meta.reason, /!plans\/plan_x\.md/);
});

test('a file the environment wrote during the run is reported, not charged to the run', () => {
  // The 2026-08-02 run: scoped files edited honestly, .omc/project-memory.json rewritten by
  // OMC alongside it. The verdict must not charge the run for it, and the reply must still
  // say it happened — a pattern that silences a path would hide a real edit next time.
  const dir = makeRun({
    result: build([{ file: 'packages/agent-sdk/src/x.ts', what: 'правка', why: 'задача' }]),
    before: '',
    after: 'U\t10\tpackages/agent-sdk/src/x.ts\nU\t7\t.omc/project-memory.json\n',
    scope: 'packages/**\n',
    envPaths: ['.omc/**'],
  });
  const { meta, reply } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'OK');
  assert.deepEqual(meta.environment_changes, ['.omc/project-memory.json']);
  assert.match(reply, /Файлы: 1 изменено/);
  assert.match(reply, /Среда: 1 изменено не прогоном — \.omc\/project-memory\.json/);
});

test('without a recorded environment the same tree still fails, as it did before', () => {
  const dir = makeRun({
    result: build([{ file: 'packages/agent-sdk/src/x.ts', what: 'правка', why: 'задача' }]),
    before: '',
    after: 'U\t10\tpackages/agent-sdk/src/x.ts\nU\t7\t.omc/project-memory.json\n',
    scope: 'packages/**\n',
  });
  const { meta } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'FAIL');
  assert.match(meta.reason, /правки вне объёма/);
});

test('a pattern that explicitly allows .git/** still fails on a .git edit', () => {
  const dir = makeRun({
    result: build([{ file: '.git/config', what: 'правка', why: 'задача' }]),
    before: '',
    after: 'U\t10\t.git/config\n',
    scope: '.git/**\n',
  });
  const { meta } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'FAIL');
  assert.match(meta.reason, /правки вне объёма/);
  assert.match(meta.reason, /\.git\/config/);
});

test('a run with no scope.txt (an older run) is not scope-checked', () => {
  // Same shape as a scope violation — a second, unrelated file changed — but with no
  // scope.txt on disk the check has to stay off, exactly as it behaved before scope existed.
  const dir = makeRun({
    result: build([{ file: 'packages/x.ts', what: 'правка', why: 'задача' }]),
    before: '',
    after: 'U\t10\tpackages/x.ts\nU\t3\trandom/other.ts\n',
  });
  const { meta } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'OK');
});

// --- commit made during the run -------------------------------------------------------

test('a HEAD that moved during the run fails, however clean the report', () => {
  const dir = makeRun({
    result: build([{ file: 'src/a.ts', what: 'правка', why: 'задача' }]),
    before: '',
    after: 'U\t10\tsrc/a.ts\n',
    headBefore: 'abcdef1234567890\n',
    headAfter: 'fedcba0987654321\n',
  });
  const { meta } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'FAIL');
  assert.match(meta.reason, /сделан коммит при запрете/);
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
  assert.match(meta.reason, /сделан коммит при запрете/);
});

test('identical HEAD before and after is not a commit violation', () => {
  const dir = makeRun({
    result: build([{ file: 'src/a.ts', what: 'правка', why: 'задача' }]),
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
    result: build([{ file: 'src/a.ts', what: 'правка', why: 'задача' }]),
    before: '',
    after: 'U\t10\tsrc/a.ts\n',
  });
  const { meta } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'OK');
});

// --- collect(): status.json -----------------------------------------------------------

test('collect() moves status.json to finished with the same status as meta.json', () => {
  const dir = makeRun({
    result: build([{ file: 'src/a.ts', what: 'правка', why: 'задача' }]),
    before: '',
    after: 'U\t10\tsrc/a.ts\n',
  });
  const { meta } = collect(dir, 'codex-build', 0);
  const status = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
  assert.equal(status.state, 'finished');
  assert.equal(status.status, meta.status);
  assert.equal(status.finished_at, meta.finished_at);
});
