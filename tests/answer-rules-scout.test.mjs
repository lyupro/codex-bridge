/** OW-068: every scout answer rule is stated in its prompt and carries the exact existing judge reason. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ANSWER_RULES, answerRuleMessage, answerRuleStatements } from '../src/home/lib/answer-rules.mjs';
import { MIN_SUBSTANCE_CHARS, MIN_SINGLE_SUBSTANCE_CHARS } from '../src/home/lib/answer-rules/scout.mjs';
import { INSTRUCTIONS } from '../src/home/lib/runner/prompts.mjs';

const AGENT = 'codex-scout';
const rules = ANSWER_RULES[AGENT];
const heading = 'Rules checked after the run (a filled answer that breaks any one is rejected whole):';

const cases = [
  ['scout-answer-every-question', { count: 2, questions: 'Q2, Q4' },
    'scout did not answer 2 sub-questions: Q2, Q4'],
  ['scout-answer-substance', { questions: 'Q1, Q3' },
    'response to Q1, Q3 contains coordinates without analysis'],
  ['scout-answer-evidence', { questions: 'Q2, Q3' },
    'responses without a single code reference: Q2, Q3'],
  ['scout-single-answer-substance', { chars: 19 },
    'response without analysis: 19 substantive characters, minimum 200 (coordinates and paths excluded)'],
  ['scout-startup-reference', { questions: 'Q1, Q4' },
    'responses to startup-context questions without a startup:<source> reference: Q1, Q4'],
  ['scout-unread-coordinate', { coordinate: 'src/file.mjs:12' },
    'scout cited src/file.mjs:12 without executing a command: an address nobody read'],
  ['scout-commands-run', {},
    'scout executed no command, so no answer rests on reading the code; check stderr.log for sandbox refusals before changing the order'],
];

test('every scout rule has an independently written, byte-exact judge reason', () => {
  assert.equal(cases.length, 7);
  assert.deepEqual(cases.map(([key]) => key), Object.keys(rules));
  for (const [key, values, expected] of cases) {
    assert.equal(answerRuleMessage(AGENT, key, values), expected, key);
  }
});

test('scout renders every catalog statement once, in order between its body and language rule', () => {
  const statements = Object.values(rules).filter((entry) => entry.when === 'always').map((entry) => entry.rule);
  assert.deepEqual(answerRuleStatements(AGENT, 'default'), statements);
  for (const questions of [[], [{ id: 'Q1' }], [{ id: 'Q1', kind: 'code-required' }]]) {
    const prompt = INSTRUCTIONS[AGENT]({}, undefined, questions);
    assert.ok(prompt.includes('Response rules:\n- You are working in read-only mode: do not try to write or edit anything.'));
    assert.ok(prompt.includes(`  grounded in the code), “Findings” (fact / location / confidence table), “Missing information”.\n${heading}\n${statements.map((rule) => `- ${rule}`).join('\n')}\n- Write the answer, report_markdown and every text field of result.json in `));
    assert.equal(prompt.split(heading).length - 1, 1);
    for (const [key, entry] of Object.entries(rules)) {
      assert.equal(prompt.split(entry.rule).length - 1, entry.when === 'always' ? 1 : 0, key);
    }
  }
});

// Plan_60 D1: the startup rule is stated only to an order that carries a startup-context question.
test('the startup reference rule is stated only when a question asks about startup context', () => {
  const startup = rules['scout-startup-reference'];
  assert.equal(startup.when, 'startup-context');
  const marked = INSTRUCTIONS[AGENT]({}, undefined, [{ id: 'Q1', kind: 'code-required' }, { id: 'Q2', kind: 'startup-context' }]);
  const unmarked = INSTRUCTIONS[AGENT]({}, undefined, [{ id: 'Q1', kind: 'code-required' }]);
  assert.equal(marked.split(startup.rule).length - 1, 1);
  assert.ok(!unmarked.includes(startup.rule));
  assert.ok(!unmarked.includes('startup:'));
  assert.deepEqual(answerRuleStatements(AGENT, 'default', { questions: [{ id: 'Q2', kind: 'startup-context' }] }),
    Object.values(rules).map((entry) => entry.rule));
});

test('substance instructions state both thresholds, counted characters and exclusions', () => {
  assert.equal(MIN_SUBSTANCE_CHARS, 80);
  assert.equal(MIN_SINGLE_SUBSTANCE_CHARS, 200);
  assert.ok(rules['scout-answer-substance'].rule.includes(String(MIN_SUBSTANCE_CHARS)));
  assert.ok(rules['scout-single-answer-substance'].rule.includes(String(MIN_SINGLE_SUBSTANCE_CHARS)));
  assert.ok(rules['scout-single-answer-substance'].rule.includes('When the order has no separate sub-questions'));
  for (const key of ['scout-answer-substance', 'scout-single-answer-substance']) {
    for (const boundary of ['letters and digits only', 'file.ext:12, file.ext:12-40',
      'anything containing a slash or backslash', 'backticks, punctuation and whitespace']) {
      assert.ok(rules[key].rule.includes(boundary), `${key}: ${boundary}`);
    }
  }
});

test('startup and command instructions state their boundaries explicitly', () => {
  assert.match(rules['scout-startup-reference'].rule, /question about handed startup context/);
  assert.match(rules['scout-startup-reference'].rule, /evidence item starting with startup: followed by non-whitespace text/);
  assert.match(rules['scout-commands-run'].rule, /commands run against the repository/);
  assert.match(rules['scout-commands-run'].rule, /except when every question asks about handed startup context/);
  assert.match(rules['scout-unread-coordinate'].rule, /no command has been executed/);
  assert.match(rules['scout-unread-coordinate'].rule, /answer evidence or finding locations; references to handed startup context are exempt/);
});

test('scout entries and their default phase and data are immutable', () => {
  assert.ok(Object.isFrozen(rules));
  for (const entry of Object.values(rules)) {
    assert.deepEqual(entry.phases, ['default']);
    for (const value of [entry, entry.phases, entry.data]) assert.ok(Object.isFrozen(value));
  }
});

test('review and build prompts have no answer-rule block while their catalogs are absent', () => {
  const scope = { label: 'scope', diffCommand: 'git diff', files: ['src/file.mjs'] };
  assert.ok(!INSTRUCTIONS['codex-review']({}, scope).includes('Rules checked after the run'));
  assert.ok(!INSTRUCTIONS['codex-build']({}).includes('Rules checked after the run'));
});
