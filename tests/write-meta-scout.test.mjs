#!/usr/bin/env node
/**
 * Guards the write-meta.mjs facade on its scout axis: parseQuestions() splitting an order
 * into sub-questions, and collect() grading a codex-scout run's coverage of them.
 *   node --test agents/codex/write-meta-scout.test.mjs
 *
 * Split out of write-meta.test.mjs (which still guards collect()'s build/review verdicts)
 * purely on line count: both files test the same facade, just different behavioural axes
 * of it, so splitting by coverage boundary here means splitting by axis, not by module.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collect, parseQuestions } from '../src/write-meta.mjs';
import { makeRun } from './meta/test-fixtures.mjs';

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

// --- parseQuestions ----------------------------------------------------------------

test('six numbered sub-questions of a real order parse into Q1..Q6', () => {
  const taskText = `Investigate Codex runs:
1. What does parseQuestions do?
2. How is outOfScope computed for service directories?
3. What happens when questions.json is missing?
4) How does markAbandoned handle a dead pid?
5) What does activeRun return for different agents?
6. How is a commit during the run handled?
Thank you.`;
  const questions = parseQuestions(taskText);
  assert.deepEqual(
    questions.map((q) => q.id),
    ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6'],
  );
  assert.equal(questions[0].text, 'What does parseQuestions do?');
  assert.equal(questions[5].text, 'How is a commit during the run handled?');
});

test('a block of six bulleted spec links is not six questions', () => {
  const taskText = `- spec: path.ts:12
- spec: path2.ts:20
- spec: path3.ts:30
- spec: path4.ts:40
- spec: path5.ts:50
- spec: path6.ts:60`;
  assert.deepEqual(parseQuestions(taskText), []);
});

test('a single question falls back to single-question mode', () => {
  assert.deepEqual(parseQuestions('How does cache invalidation work?'), []);
});

test('a repeated question is deduped rather than counted twice', () => {
  const taskText = `1. What does function X do?
2. What does function X do?
3. How does Y work?`;
  const questions = parseQuestions(taskText);
  assert.deepEqual(
    questions.map((q) => q.text),
    ['What does function X do?', 'How does Y work?'],
  );
});

test('an oversized question is cut to 300 characters', () => {
  const longText = 'a'.repeat(350);
  const taskText = `1. ${longText}\n2. Short question?`;
  const questions = parseQuestions(taskText);
  assert.equal(questions[0].text.length, 300);
  assert.equal(questions[0].text, longText.slice(0, 300));
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
