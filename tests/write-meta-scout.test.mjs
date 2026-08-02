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

// substanceLength('ответ') = 5, well under MIN_SINGLE_SUBSTANCE_CHARS (200).
const THIN_ANSWER = 'ответ';
// substanceLength ≈ 149 — over MIN_SUBSTANCE_CHARS (80) for per-question coverage, under
// the single-question bar (200), so it only ever stands in for a per-question answer.
const PROSE_ANSWER =
  'Раздел объясняет, как компонент собирает данные, проверяет их корректность и передаёт дальше по цепочке обработки, включая обработку ошибок и логирование промежуточных шагов.';
// substanceLength ≈ 227 — clears MIN_SINGLE_SUBSTANCE_CHARS (200), for single-question mode.
const LONG_PROSE_ANSWER =
  'Модуль читает файл построчно, разбирает поля по формату и проверяет корректность значений, прежде чем передать их дальше по конвейеру обработки данных без побочных эффектов и лишних исключений в рантайме. Отдельно описан контракт ошибок и порядок вызова зависимостей.';
// substanceLength = 0 — a coordinate table with nothing else, the exact shape the thin
// check exists to catch.
const COORDINATES_ONLY = 'packages/x/src/source.ts:60-79, registry.ts:14';

// --- parseQuestions ----------------------------------------------------------------

test('six numbered sub-questions of a real order parse into Q1..Q6', () => {
  const taskText = `Нужно разобраться с прогонами Codex:
1. Что делает функция parseQuestions?
2. Как вычисляется outOfScope для служебных каталогов?
3. Что происходит, если questions.json отсутствует?
4) Как работает markAbandoned для мёртвого pid?
5) Что возвращает activeRun при разных агентах?
6. Как учитывается коммит во время прогона?
Спасибо.`;
  const questions = parseQuestions(taskText);
  assert.deepEqual(
    questions.map((q) => q.id),
    ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6'],
  );
  assert.equal(questions[0].text, 'Что делает функция parseQuestions?');
  assert.equal(questions[5].text, 'Как учитывается коммит во время прогона?');
});

test('a block of six bulleted spec links is not six questions', () => {
  const taskText = `- спека: path.ts:12
- спека: path2.ts:20
- спека: path3.ts:30
- спека: path4.ts:40
- спека: path5.ts:50
- спека: path6.ts:60`;
  assert.deepEqual(parseQuestions(taskText), []);
});

test('a single question falls back to single-question mode', () => {
  assert.deepEqual(parseQuestions('Как работает кэш инвалидации?'), []);
});

test('a repeated question is deduped rather than counted twice', () => {
  const taskText = `1. Что делает функция X?
2. Что делает функция X?
3. Как работает Y?`;
  const questions = parseQuestions(taskText);
  assert.deepEqual(
    questions.map((q) => q.text),
    ['Что делает функция X?', 'Как работает Y?'],
  );
});

test('an oversized question is cut to 300 characters', () => {
  const longText = 'а'.repeat(350);
  const taskText = `1. ${longText}\n2. Короткий вопрос?`;
  const questions = parseQuestions(taskText);
  assert.equal(questions[0].text.length, 300);
  assert.equal(questions[0].text, longText.slice(0, 300));
});

// --- scout coverage against questions.json ------------------------------------------

test('a fully covered order is OK and reports 6/6 in the reply', () => {
  const questions = Array.from({ length: 6 }, (_, i) => ({ id: `Q${i + 1}`, text: `Вопрос ${i + 1}?` }));
  const answers = questions.map((q) => ({
    question_id: q.id,
    answer: PROSE_ANSWER,
    evidence: [`agents/codex/write-meta.mjs:${300 + Number(q.id.slice(1))}`],
  }));
  const dir = makeRun({
    result: { answer: 'Итоговая сводка по всем подвопросам.', answers, findings: [], unknowns: [], report_markdown: '# отчёт' },
    questions,
  });
  const { meta, reply } = collect(dir, 'codex-scout', 0);
  assert.equal(meta.status, 'OK');
  assert.match(reply, /Покрытие: 6\/6 подвопросов/);
});

test('skipping two sub-questions fails and names them', () => {
  const questions = Array.from({ length: 6 }, (_, i) => ({ id: `Q${i + 1}`, text: `Вопрос ${i + 1}?` }));
  const answers = questions.slice(0, 4).map((q) => ({ question_id: q.id, answer: PROSE_ANSWER, evidence: ['x.ts:1'] }));
  const dir = makeRun({
    result: { answer: 'Сводка', answers, findings: [], unknowns: [], report_markdown: '# отчёт' },
    questions,
  });
  const { meta } = collect(dir, 'codex-scout', 0);
  assert.equal(meta.status, 'FAIL');
  assert.match(meta.reason, /разведка не ответила на 2 подвопросов/);
  assert.match(meta.reason, /Q5/);
  assert.match(meta.reason, /Q6/);
});

test('a table of coordinates instead of a breakdown fails per question', () => {
  const questions = [
    { id: 'Q1', text: 'Где источник?' },
    { id: 'Q2', text: 'Где реестр?' },
  ];
  const answers = [
    { question_id: 'Q1', answer: COORDINATES_ONLY, evidence: ['packages/x/src/source.ts:60'] },
    { question_id: 'Q2', answer: 'registry.ts:14', evidence: ['registry.ts:14'] },
  ];
  const dir = makeRun({
    result: { answer: 'Сводка', answers, findings: [], unknowns: [], report_markdown: '# отчёт' },
    questions,
  });
  const { meta } = collect(dir, 'codex-scout', 0);
  assert.equal(meta.status, 'FAIL');
  assert.match(meta.reason, /координаты без разбора/);
});

test('an answer with no evidence at all fails, even with real prose', () => {
  const questions = [
    { id: 'Q1', text: 'Как работает X?' },
    { id: 'Q2', text: 'Как работает Y?' },
  ];
  const answers = [
    { question_id: 'Q1', answer: PROSE_ANSWER, evidence: [] },
    { question_id: 'Q2', answer: PROSE_ANSWER, evidence: ['   '] },
  ];
  const dir = makeRun({
    result: { answer: 'Сводка', answers, findings: [], unknowns: [], report_markdown: '# отчёт' },
    questions,
  });
  const { meta } = collect(dir, 'codex-scout', 0);
  assert.equal(meta.status, 'FAIL');
  assert.match(meta.reason, /ответы без единой ссылки на код/);
});

test('single-question mode fails a short answer', () => {
  const dir = makeRun({
    result: { answer: THIN_ANSWER, findings: [], unknowns: [], report_markdown: '# отчёт' },
  });
  const { meta } = collect(dir, 'codex-scout', 0);
  assert.equal(meta.status, 'FAIL');
  assert.match(meta.reason, /ответ без разбора/);
});

test('single-question mode passes a substantial answer, with no coverage line', () => {
  const dir = makeRun({
    result: { answer: LONG_PROSE_ANSWER, findings: [], unknowns: [], report_markdown: '# отчёт' },
  });
  const { meta, reply } = collect(dir, 'codex-scout', 0);
  assert.equal(meta.status, 'OK');
  assert.doesNotMatch(reply, /Покрытие/);
});
