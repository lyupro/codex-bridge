/** Guards the Plan_60 D1 orderer-only marker and ordered question-kind transport. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTEXT_ONLY_MARKER, QUESTION_KIND, questionKindRefusal, questionsFromTexts,
} from '../../src/home/lib/runner/question-kind.mjs';

const refused = [
  '[Context-Only] x',
  '[context only] x',
  '[context_only] x',
  'x [context-only]',
  '[context-only] a [context-only] b',
  '[context-only]x',
  '[context-only]',
  '[context-only]   ',
  '[ context--__ only ] x',
  ' [context-only] x',
  '[context-only] a [Context Only] b',
  '[context-only]\t\n',
];

for (const text of refused) {
  test(`refuses ${JSON.stringify(text)} with its question number and quoted text`, () => {
    const reason = questionKindRefusal(['An ordinary question.', text]);
    assert.match(reason, /Q2/);
    assert.ok(reason.includes(JSON.stringify(text)));
    assert.doesNotMatch(reason, /[\r\n]/);
    assert.throws(() => questionsFromTexts(['An ordinary question.', text]), { message: reason });
  });
}

test('an exact prefix strips its marker and following whitespace while retaining the question', () => {
  const text = `${CONTEXT_ONLY_MARKER} \t\nWhat were you handed?  `;
  assert.equal(questionKindRefusal([text]), null);
  assert.deepEqual(questionsFromTexts([text]), [
    { id: 'Q1', text: 'What were you handed?  ', kind: QUESTION_KIND.STARTUP_CONTEXT },
  ]);
});

test('an unmarked question is retained byte for byte', () => {
  const text = ' \tWhere is the code?\n  ';
  assert.equal(questionKindRefusal([text]), null);
  assert.deepEqual(questionsFromTexts([text]), [
    { id: 'Q1', text, kind: QUESTION_KIND.CODE_REQUIRED },
  ]);
});

test('mixed question kinds preserve order and consecutive ids', () => {
  assert.deepEqual(questionsFromTexts(['First?', '[context-only] Second?', 'Third?']), [
    { id: 'Q1', text: 'First?', kind: 'code-required' },
    { id: 'Q2', text: 'Second?', kind: 'startup-context' },
    { id: 'Q3', text: 'Third?', kind: 'code-required' },
  ]);
});

test('empty input is accepted and the kind vocabulary is frozen', () => {
  assert.equal(questionKindRefusal(), null);
  assert.deepEqual(questionsFromTexts(), []);
  assert.equal(CONTEXT_ONLY_MARKER, '[context-only]');
  assert.deepEqual(QUESTION_KIND, { STARTUP_CONTEXT: 'startup-context', CODE_REQUIRED: 'code-required' });
  assert.ok(Object.isFrozen(QUESTION_KIND));
});
