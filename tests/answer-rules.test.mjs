/** OW-068: every advisor answer rule is stated in its phase prompt and carries the exact judge reason. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ANSWER_RULES, answerRuleMessage, answerRuleStatements, validateAnswerRules } from '../src/home/lib/answer-rules.mjs';
import { BACKSTOPS, UNLISTED_OPTION_MIN_CHARS } from '../src/home/lib/answer-rules/advisor.mjs';
import { INSTRUCTIONS } from '../src/home/lib/runner/prompts.mjs';

const AGENT = 'codex-advisor';
const rules = ANSWER_RULES[AGENT];

// OW-068 / Plan_80 E21: literal judge reasons guard against prompt/catalog drift before judge migration.
const cases = [
  ['advisor-citation-path', { field: 'why', label: ':1' },
    'D3 why ":1": use a repository-relative path:line or path:line-line address.'],
  ['advisor-citation-existing-file', { field: 'why', label: 'src/missing.mjs:1' },
    'D3 why "src/missing.mjs:1": cite an existing file under repoRoot.'],
  ['advisor-citation-readable-file', { field: 'why', label: 'src/locked.mjs:1' },
    'D3 why "src/locked.mjs:1": cite a readable file under repoRoot.'],
  ['advisor-citation-line-range', { field: 'why', label: 'src/file.mjs:2-99', count: 12 },
    'D3 why "src/file.mjs:2-99": use an ascending line range within this file\'s 12 lines.'],
  ['advisor-citation-allowed-path', { field: 'why', label: 'src/outside.mjs:1' },
    'D3 why "src/outside.mjs:1": cite a task path or a scope missing_paths entry.'],
  ['advisor-prose-address', { field: 'why', label: 'src/file.mjs:bad' },
    'D3 why "src/file.mjs:bad": use a repository-relative path:line or path:line-line address.'],
  ['advisor-verified-evidence', { index: 2 },
    'D10 assumptions[2].evidence []: a VERIFIED assumption needs at least one location.'],
  ['advisor-inspect-evidence', { index: 1 },
    'D10 pre_mortem[1].early_check.evidence []: an inspect check needs at least one location.'],
  ['advisor-control-character', { field: 'why', codePoint: 'U+0000' },
    'integrity why: remove control character U+0000.'],
  ['advisor-lone-surrogate', { field: 'why', codePoint: 'U+D800' },
    'integrity why: remove lone surrogate U+D800.'],
  ['advisor-commands-run', {},
    'D4 commandsRun 0: inspect repository evidence before answering.'],
  ['advisor-taken-on-trust', {},
    'D4 taken_on_trust []: name at least one assumption taken on trust.'],
  ['advisor-insufficient-missing-paths', {},
    'D4 missing_paths [] with sufficient false: name the paths needed for advice.'],
  ['advisor-sufficient-missing-paths', { missingPaths: ['src/needed.mjs'] },
    'D4 missing_paths ["src/needed.mjs"] with sufficient true: resolve the scope contradiction.'],
  ['advisor-unique-risk-id', { index: 1, id: 'r1' },
    'D10 predicted_risks[1].id "r1": use a unique predicted risk id.'],
  ['advisor-recommendation-option-id', { optionId: 'unknown' },
    'D5 recommendation.option_id "unknown": choose a task option id.'],
  ['advisor-unlisted-option-length', { unlistedOption: 'short' },
    'D10 unlisted_option "short": describe an unlisted option in at least 40 characters.'],
  ['advisor-reject-all-options', { missing: ['first', 'second'] },
    'D10 rejected ["first","second"]: reject every task option when recommending "none-of-these".'],
  ['advisor-listed-option-none', { unlistedOption: 'another choice' },
    'D10 unlisted_option "another choice": use "none" when recommending a task option.'],
  ['advisor-rejected-option-id', { index: 0, optionId: 'unknown' },
    'D5 rejected[0].option_id "unknown": use a task option id.'],
  ['advisor-reject-recommended-option', { index: 1, optionId: 'first' },
    'D5 rejected[1].option_id "first": do not reject the recommended option.'],
  ['advisor-risk-outcome-id', { index: 0, riskId: 'r9' },
    'D10 risk_outcomes[0].risk_id "r9": use a scope predicted risk id.'],
  ['advisor-one-outcome-per-risk', { riskId: 'r1', count: 2 },
    'D10 risk_outcomes "r1" count 2: provide exactly one outcome per predicted risk.'],
  ['advisor-backstop-phrase', { field: 'why', match: 'BOTH, options are good', phrase: 'both options are good' },
    'D5 why "BOTH, options are good": replace backstop phrase "both options are good" with a decision.'],
];

test('every advisor rule has an independently written, byte-exact judge reason', () => {
  assert.equal(cases.length, 24);
  assert.deepEqual(cases.map(([key]) => key), Object.keys(rules));
  for (const [key, values, expected] of cases) {
    assert.equal(answerRuleMessage(AGENT, key, values), expected, key);
  }
  assert.equal(answerRuleMessage(AGENT, 'advisor-commands-run'),
    'D4 commandsRun 0: inspect repository evidence before answering.');
});

test('each phase renders exactly its catalog statements in catalog order after its phase section', () => {
  for (const phase of ['scope', 'advise']) {
    const prompt = INSTRUCTIONS[AGENT]({ phase });
    const heading = 'Rules checked after the run (a filled answer that breaks any one is rejected whole):';
    assert.ok(prompt.indexOf(heading) > prompt.indexOf(phase === 'scope' ? 'Scope phase:' : 'Advise phase:'));
    const expected = Object.values(rules).filter((entry) => entry.phases.includes(phase)).map((entry) => entry.rule);
    assert.deepEqual(answerRuleStatements(AGENT, phase), expected);
    assert.ok(prompt.includes(`${heading}\n${expected.map((rule) => `- ${rule}`).join('\n')}`));
    for (const [key, entry] of Object.entries(rules)) {
      assert.equal(prompt.includes(entry.rule), entry.phases.includes(phase), `${phase}: ${key}`);
    }
  }
});

test('advisor entries have the exact phase reach of the judge producers', () => {
  const scopeOnly = new Set(['advisor-taken-on-trust', 'advisor-insufficient-missing-paths',
    'advisor-sufficient-missing-paths', 'advisor-unique-risk-id']);
  const both = new Set(['advisor-citation-path', 'advisor-citation-existing-file',
    'advisor-citation-readable-file', 'advisor-citation-line-range', 'advisor-citation-allowed-path',
    'advisor-prose-address', 'advisor-control-character', 'advisor-lone-surrogate',
    'advisor-commands-run', 'advisor-backstop-phrase']);
  for (const [key, entry] of Object.entries(rules)) {
    assert.deepEqual(entry.phases, scopeOnly.has(key) ? ['scope'] : both.has(key) ? ['scope', 'advise'] : ['advise'], key);
  }
});

test('policy statements derive the length threshold and all backstop phrases from shared data', () => {
  const lengthRule = rules['advisor-unlisted-option-length'].rule;
  assert.ok(lengthRule.includes(String(UNLISTED_OPTION_MIN_CHARS)));
  assert.match(lengthRule, /Unicode code points after trimming/);
  const backstopRule = rules['advisor-backstop-phrase'].rule;
  for (const phrase of Object.values(BACKSTOPS).flat()) assert.ok(backstopRule.includes(phrase), phrase);
  for (const boundary of ['every text field', 'NFKC', 'ignoring case', 'between letters within words',
    'between words', 'no adjacent letter or number', 'both lists for another language']) {
    assert.ok(backstopRule.includes(boundary), boundary);
  }
  const rangeRule = rules['advisor-citation-line-range'].rule;
  for (const boundary of ['safe integer', 'ascending', 'at least 1', 'at least line_start',
    "at or before the file's last line", 'empty file']) assert.ok(rangeRule.includes(boundary), boundary);
});

function catalog(entry, key = 'example-rule') {
  return { [AGENT]: { [key]: entry } };
}

function validEntry() {
  return { phases: ['scope'], rule: 'Read evidence before answering.', message: () => 'reason', data: [] };
}

test('catalog validation accepts the installed catalog and rejects invalid keys', () => {
  assert.doesNotThrow(() => validateAnswerRules(ANSWER_RULES));
  assert.throws(() => validateAnswerRules(catalog(validEntry(), 'Bad_key')), /invalid answer rule key/);
});

test('catalog validation requires exactly its four fields', () => {
  const entry = validEntry();
  delete entry.message;
  assert.throws(() => validateAnswerRules(catalog(entry)), /invalid answer rule entry/);
  assert.throws(() => validateAnswerRules(catalog({ ...validEntry(), extra: true })), /invalid answer rule entry/);
});

test('catalog validation rejects empty or unresolved rule text', () => {
  for (const rule of ['', '  ', '{{minimum}} characters.']) {
    assert.throws(() => validateAnswerRules(catalog({ ...validEntry(), rule })), /invalid answer rule text/);
  }
});

test('catalog validation requires a non-empty array of known phases', () => {
  for (const phases of [['build'], [], 'scope']) {
    assert.throws(() => validateAnswerRules(catalog({ ...validEntry(), phases })), /unknown answer rule phase/);
  }
});

test('catalog validation rejects non-functions and duplicate or empty data names', () => {
  assert.throws(() => validateAnswerRules(catalog({ ...validEntry(), message: 'reason' })), /invalid answer rule message/);
  for (const data of [['field', 'field'], [''], ['  '], [7], 'field']) {
    assert.throws(() => validateAnswerRules(catalog({ ...validEntry(), data })), /invalid answer rule data/);
  }
});

test('catalog keys must be unique across agents', () => {
  assert.throws(() => validateAnswerRules({
    [AGENT]: { 'example-rule': validEntry() },
    'codex-scout': { 'example-rule': validEntry() },
  }, { [AGENT]: ['scope', 'advise'], 'codex-scout': ['scope', 'advise'] }), /duplicate answer rule key/);
});

test('catalog validation refuses an agent without a phase row', () => {
  assert.throws(() => validateAnswerRules({ 'codex-scout': { 'example-rule': validEntry() } }),
    /unknown answer rule agent: codex-scout/);
});

test('message lookup rejects unknown agents, unknown keys, missing names and extra names', () => {
  assert.throws(() => answerRuleMessage('unknown', 'advisor-commands-run'), /unknown answer rule agent/);
  assert.throws(() => answerRuleStatements('unknown', 'scope'), /unknown answer rule agent/);
  assert.throws(() => answerRuleMessage(AGENT, 'unknown'), /unknown answer rule/);
  assert.throws(() => answerRuleMessage(AGENT, 'advisor-citation-path', { field: 'why' }), /invalid answer rule values/);
  assert.throws(() => answerRuleMessage(AGENT, 'advisor-citation-path', { field: 'why', extra: 1 }), /invalid answer rule values/);
  assert.throws(() => answerRuleMessage(AGENT, 'advisor-commands-run', { extra: 1 }), /invalid answer rule values/);
  assert.throws(() => answerRuleMessage(AGENT, 'advisor-citation-path',
    Object.create({ field: 'why', label: 'file:1' })), /invalid answer rule values/);
  for (const values of [null, [], 'value']) {
    assert.throws(() => answerRuleMessage(AGENT, 'advisor-commands-run', values), /invalid answer rule values/);
  }
});

test('catalog entries and policy data are immutable', () => {
  assert.ok(Object.isFrozen(ANSWER_RULES));
  assert.ok(Object.isFrozen(rules));
  for (const entry of Object.values(rules)) {
    for (const value of [entry, entry.phases, entry.data]) assert.ok(Object.isFrozen(value));
  }
  assert.ok(Object.isFrozen(BACKSTOPS));
  for (const phrases of Object.values(BACKSTOPS)) assert.ok(Object.isFrozen(phrases));
});
