#!/usr/bin/env node
/**
 * Guards the write-meta.mjs facade on its scout axis: explicit orchestrator questions and
 * collect() grading a codex-scout run's coverage of them.
 *   node --test agents/codex/write-meta-scout.test.mjs
 *
 * Split out of write-meta.test.mjs (which still guards collect()'s build/review verdicts)
 * purely on line count: both files test the same facade, just different behavioural axes
 * of it, so splitting by coverage boundary here means splitting by axis, not by module.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { collect } from '../src/write-meta.mjs';
import { questionsFromFlags } from '../src/runner/launcher.mjs';
import { makeRun } from './meta/test-fixtures.mjs';

const RUN_CODEX = new URL('../src/run-codex.mjs', import.meta.url).href;

function parseArgsInChild(argv) {
  const source = `import { parseArgs } from ${JSON.stringify(RUN_CODEX)};
process.stdout.write(JSON.stringify(parseArgs(JSON.parse(process.env.CODEX_TEST_ARGV))));`;
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8',
    env: { ...process.env, CODEX_TEST_ARGV: JSON.stringify(argv) },
  });
  return { code: out.status, stderr: out.stderr || '', opts: out.stdout ? JSON.parse(out.stdout) : null };
}

// substanceLength('reply') = 5, well under MIN_SINGLE_SUBSTANCE_CHARS (200).
const THIN_ANSWER = 'reply';
// substanceLength ≈ 149 — over MIN_SUBSTANCE_CHARS (80) for per-question coverage, under
// the single-question bar (200), so it only ever stands in for a per-question answer.
const PROSE_ANSWER =
  'The section explains how the component collects data, validates it, and passes it along ' +
  'the processing chain, including error handling and logging of intermediate steps.';
// substanceLength ≈ 227 — clears MIN_SINGLE_SUBSTANCE_CHARS (200), for single-question mode.
const LONG_PROSE_ANSWER =
  'The module reads the file line by line, parses fields according to the format, and validates ' +
  'values before passing them through the processing pipeline without side effects or needless ' +
  'runtime exceptions. The error contract and dependency call order are described separately.';
// substanceLength = 0 — a coordinate table with nothing else, the exact shape the thin
// check exists to catch.
const COORDINATES_ONLY = 'packages/x/src/source.ts:60-79, registry.ts:14';

// --- explicit scout questions --------------------------------------------------------

test('codex-scout refuses before launch without --question', () => {
  const { code, stderr } = parseArgsInChild([
    '--agent',
    'codex-scout',
    '--order-id',
    'ord-1',
  ]);
  assert.equal(code, 2);
  assert.match(stderr, /--question is required/);
});

test('repeatable flags build questions.json entries in the given order', () => {
  const { code, opts } = parseArgsInChild([
    '--agent',
    'codex-scout',
    '--order-id',
    'ord-1',
    '--question',
    'First wording is preserved.',
    '--question',
    'Second wording is preserved exactly.',
  ]);
  assert.equal(code, 0);
  assert.deepEqual(questionsFromFlags(opts.questions), [
    { id: 'Q1', text: 'First wording is preserved.' },
    { id: 'Q2', text: 'Second wording is preserved exactly.' },
  ]);
});

// --- scout coverage against questions.json ------------------------------------------

test('a fully covered order is OK and reports 6/6 in the reply', () => {
  const questions = Array.from({ length: 6 }, (_, i) => ({ id: `Q${i + 1}`, text: `Question ${i + 1}?` }));
  const answers = questions.map((q) => ({
    question_id: q.id,
    answer: PROSE_ANSWER,
    evidence: [`agents/codex/write-meta.mjs:${300 + Number(q.id.slice(1))}`],
  }));
  const dir = makeRun({
    result: { answer: 'Final summary of all sub-questions.', answers, findings: [], unknowns: [], report_markdown: '# report' },
    questions,
  });
  const { meta, reply } = collect(dir, 'codex-scout', 0);
  assert.equal(meta.status, 'OK');
  assert.match(reply, /Coverage: 6\/6 sub-questions/);
});

test('a single explicit question is graded and reports 1/1 in the reply', () => {
  const questions = [{ id: 'Q1', text: 'Describe the mechanism.' }];
  const dir = makeRun({
    result: {
      answer: 'Summary of the mechanism.',
      answers: [{ question_id: 'Q1', answer: PROSE_ANSWER, evidence: ['src/mechanism.mjs:1'] }],
      findings: [],
      unknowns: [],
      report_markdown: '# report',
    },
    questions,
  });
  const { meta, reply } = collect(dir, 'codex-scout', 0);
  assert.equal(meta.status, 'OK');
  assert.match(reply, /Coverage: 1\/1 sub-questions/);
});

test('coverage counts only the explicit questions', () => {
  const questions = [
    { id: 'Q1', text: 'First flag, even without a question mark' },
    { id: 'Q2', text: 'Second flag, also imperative' },
  ];
  const answers = [
    { question_id: 'Q1', answer: PROSE_ANSWER, evidence: ['src/one.mjs:1'] },
    { question_id: 'Q2', answer: PROSE_ANSWER, evidence: ['src/two.mjs:1'] },
    { question_id: 'Q99', answer: PROSE_ANSWER, evidence: ['src/extra.mjs:1'] },
  ];
  const dir = makeRun({
    result: { answer: 'Summary', answers, findings: [], unknowns: [], report_markdown: '# report' },
    questions,
  });
  const { meta, reply } = collect(dir, 'codex-scout', 0);
  assert.equal(meta.status, 'OK');
  assert.match(reply, /Coverage: 2\/2 sub-questions/);
});

test('skipping two sub-questions fails and names them', () => {
  const questions = Array.from({ length: 6 }, (_, i) => ({ id: `Q${i + 1}`, text: `Question ${i + 1}?` }));
  const answers = questions.slice(0, 4).map((q) => ({ question_id: q.id, answer: PROSE_ANSWER, evidence: ['x.ts:1'] }));
  const dir = makeRun({
    result: { answer: 'Summary', answers, findings: [], unknowns: [], report_markdown: '# report' },
    questions,
  });
  const { meta } = collect(dir, 'codex-scout', 0);
  assert.equal(meta.status, 'FAIL');
  assert.match(meta.reason, /scout did not answer 2 sub-questions/);
  assert.match(meta.reason, /Q5/);
  assert.match(meta.reason, /Q6/);
});

test('a table of coordinates instead of a breakdown fails per question', () => {
  const questions = [
    { id: 'Q1', text: 'Where is the source?' },
    { id: 'Q2', text: 'Where is the registry?' },
  ];
  const answers = [
    { question_id: 'Q1', answer: COORDINATES_ONLY, evidence: ['packages/x/src/source.ts:60'] },
    { question_id: 'Q2', answer: 'registry.ts:14', evidence: ['registry.ts:14'] },
  ];
  const dir = makeRun({
    result: { answer: 'Summary', answers, findings: [], unknowns: [], report_markdown: '# report' },
    questions,
  });
  const { meta } = collect(dir, 'codex-scout', 0);
  assert.equal(meta.status, 'FAIL');
  assert.match(meta.reason, /coordinates without analysis/);
});

test('a single coordinate-only answer still fails the analysis check', () => {
  const dir = makeRun({
    result: {
      answer: 'Summary',
      answers: [{ question_id: 'Q1', answer: COORDINATES_ONLY, evidence: ['src/source.mjs:60'] }],
      findings: [],
      unknowns: [],
      report_markdown: '# report',
    },
    questions: [{ id: 'Q1', text: 'Where is the source?' }],
  });
  const { meta } = collect(dir, 'codex-scout', 0);
  assert.equal(meta.status, 'FAIL');
  assert.match(meta.reason, /coordinates without analysis/);
});

test('an answer with no evidence at all fails, even with real prose', () => {
  const questions = [
    { id: 'Q1', text: 'How does X work?' },
    { id: 'Q2', text: 'How does Y work?' },
  ];
  const answers = [
    { question_id: 'Q1', answer: PROSE_ANSWER, evidence: [] },
    { question_id: 'Q2', answer: PROSE_ANSWER, evidence: ['   '] },
  ];
  const dir = makeRun({
    result: { answer: 'Summary', answers, findings: [], unknowns: [], report_markdown: '# report' },
    questions,
  });
  const { meta } = collect(dir, 'codex-scout', 0);
  assert.equal(meta.status, 'FAIL');
  assert.match(meta.reason, /responses without a single code reference/);
});

test('an unanswered explicit question fails the run', () => {
  const dir = makeRun({
    result: {
      answer: 'Summary',
      answers: [],
      findings: [],
      unknowns: [],
      report_markdown: '# report',
    },
    questions: [{ id: 'Q1', text: 'This question was not answered.' }],
  });
  const { meta } = collect(dir, 'codex-scout', 0);
  assert.equal(meta.status, 'FAIL');
  assert.match(meta.reason, /scout did not answer 1 sub-questions/);
  assert.match(meta.reason, /Q1/);
});

test('single-question mode fails a short answer', () => {
  const dir = makeRun({
    result: { answer: THIN_ANSWER, findings: [], unknowns: [], report_markdown: '# report' },
  });
  const { meta } = collect(dir, 'codex-scout', 0);
  assert.equal(meta.status, 'FAIL');
  assert.match(meta.reason, /response without analysis/);
});

test('single-question mode passes a substantial answer, with no coverage line', () => {
  const dir = makeRun({
    result: { answer: LONG_PROSE_ANSWER, findings: [], unknowns: [], report_markdown: '# report' },
  });
  const { meta, reply } = collect(dir, 'codex-scout', 0);
  assert.equal(meta.status, 'OK');
  assert.doesNotMatch(reply, /Coverage/);
});
