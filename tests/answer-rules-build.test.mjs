/** OW-068: every build answer rule states its boundary and preserves the existing judge reason and prompt. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ANSWER_RULES, answerRuleMessage, answerRuleStatements } from '../src/home/lib/answer-rules.mjs';
import { WRONG_WORK } from '../src/home/lib/answer-rules/build.mjs';
import { INSTRUCTIONS } from '../src/home/lib/runner/prompts.mjs';

const AGENT = 'codex-build';
const rules = ANSWER_RULES[AGENT];
const heading = 'Rules checked after the run (a filled answer that breaks any one is rejected whole):';

const cases = [
  ['build-commit', { before: '0123456789abcdef', after: 'fedcba9876543210' },
    'commit made despite prohibition: 0123456789ab → fedcba987654'],
  ['build-branch-detached', { before: 'main' },
    'branch moved despite prohibition: main → detached HEAD'],
  ['build-branch-moved', { before: 'main', after: 'feature/build' },
    'branch moved despite prohibition: main → feature/build'],
  ['build-verify-failed', { command: 'npm test' },
    'verification “npm test” failed; changes remain in the tree'],
  ['build-outcome-fail', { summary: 'The ordered module is absent.' },
    'the task was not done: The ordered module is absent.'],
  ['build-outcome-missing', {},
    'result is not filled in: the response contract requires outcome "done" or "fail"'],
  ['build-outcome-unknown', { value: 'DONE' },
    'result declares an unknown outcome “DONE”, expected "done" or "fail"'],
  ['build-out-of-scope', { files: ['a', 'b', 'c', 'd'] },
    'out-of-scope changes (4): a, b, c'],
  ['build-report-names-nothing', { touched: ['src/a.mjs', 'src/b.mjs', 'src/c.mjs', 'src/d.mjs'] },
    'wrong work was done: tree changed (4: src/a.mjs, src/b.mjs, src/c.mjs), but the report names no changes'],
  ['build-report-service-directories', { service: ['.git/config', '.claude/settings.json', '.omx/state.json', '.codex/config.toml'] },
    'wrong work was done: report describes work in service directories (.git/config, .claude/settings.json, .omx/state.json), not task files'],
  ['build-report-mismatch', { declared: ['src/a.mjs', 'src/b.mjs', 'src/c.mjs', 'src/d.mjs'],
    touched: ['tests/a.mjs', 'tests/b.mjs', 'tests/c.mjs', 'tests/d.mjs'] },
    'wrong work was done: report names src/a.mjs, src/b.mjs, src/c.mjs, but tests/a.mjs, tests/b.mjs, tests/c.mjs changed'],
  ['build-report-no-change', {},
    'run did not change the tree, and earlier runs of this task do not contain the declared files'],
];

test('every build rule has an independently written, byte-exact judge reason', () => {
  assert.equal(cases.length, 12);
  assert.deepEqual(cases.map(([key]) => key), Object.keys(rules));
  assert.equal(WRONG_WORK, 'wrong work was done: ');
  for (const [key, values, expected] of cases) {
    assert.equal(answerRuleMessage(AGENT, key, values), expected, key);
  }
});

test('build reasons preserve detached starts, absent summaries and caller-shortened values', () => {
  assert.equal(answerRuleMessage(AGENT, 'build-branch-moved', { before: '', after: 'main' }),
    'branch moved despite prohibition: detached HEAD → main');
  assert.equal(answerRuleMessage(AGENT, 'build-outcome-fail', { summary: '' }),
    'the task was not done: build declared fail and gave no summary');
  assert.equal(answerRuleMessage(AGENT, 'build-outcome-fail', { summary: 'Already shortened…' }),
    'the task was not done: Already shortened…');
  assert.equal(answerRuleMessage(AGENT, 'build-outcome-unknown', { value: 'Unexpected…' }),
    'result declares an unknown outcome “Unexpected…”, expected "done" or "fail"');
  assert.equal(answerRuleMessage(AGENT, 'build-verify-failed', { command: 'Already shortened…' }),
    'verification “Already shortened…” failed; changes remain in the tree');
  assert.equal(answerRuleMessage(AGENT, 'build-verify-failed', { command: 'no command' }),
    'verification “no command” failed; changes remain in the tree');
});

test('build renders every catalog statement once, in order between its body and language rule', () => {
  const statements = Object.values(rules).map((entry) => entry.rule);
  assert.deepEqual(answerRuleStatements(AGENT, 'default'), statements);
  assert.deepEqual(answerRuleStatements(AGENT, 'scope'), []);
  for (const opts of [{}, { verify: 'npm test' }, { verify: 'node --test', phase: 'default' }]) {
    const prompt = INSTRUCTIONS[AGENT](opts);
    const block = `\n${heading}\n${statements.map((rule) => `- ${rule}`).join('\n')}`;
    assert.ok(prompt.includes(`  “Remaining work / risks”.${block}\n- Write the answer, report_markdown and every text field of result.json in `));
    assert.equal(prompt.split(heading).length - 1, 1);
    for (const [key, entry] of Object.entries(rules)) {
      assert.equal(prompt.split(entry.rule).length - 1, 1, key);
    }
  }
});

test('build instructions state the work, verification, outcome and report boundaries', () => {
  assert.match(rules['build-commit'].rule, /Do not make a commit or otherwise change HEAD during the run/);
  assert.match(rules['build-branch-detached'].rule, /Do not detach HEAD during the run/);
  assert.match(rules['build-branch-moved'].rule, /Do not create a new branch or switch branches/);
  assert.match(rules['build-verify-failed'].rule, /verify_passed: false fails the run and leaves the changes in the tree/);
  assert.match(rules['build-outcome-fail'].rule, /requested work was not carried out.*summary/);
  assert.match(rules['build-outcome-missing'].rule, /requires outcome.*missing, null or empty outcome fails/);
  assert.match(rules['build-outcome-unknown'].rule, /exactly "done" or "fail".*different case or surrounding whitespace/);
  assert.match(rules['build-out-of-scope'].rule, /Every changed file must match the order's scope/);
  assert.match(rules['build-report-names-nothing'].rule, /report naming no changes fails when task files changed/);
  assert.match(rules['build-report-service-directories'].rule, /never a path inside a service directory such as \.git\/ or \.claude\//);
  assert.match(rules['build-report-mismatch'].rule, /files the run actually changed, or files changed by earlier runs of this same task/);
  assert.match(rules['build-report-no-change'].rule, /leave changes\[\] empty unless the declared files were changed by earlier runs of this same task/);
});

test('build entries are immutable, always stated in the default phase and require their data', () => {
  assert.ok(Object.isFrozen(rules));
  for (const [key, entry] of Object.entries(rules)) {
    assert.deepEqual(entry.phases, ['default']);
    assert.equal(entry.when, 'always');
    for (const value of [entry, entry.phases, entry.data]) assert.ok(Object.isFrozen(value));
    assert.throws(() => answerRuleMessage(AGENT, key, { unexpected: true }), /invalid answer rule values/);
    if (entry.data.length) {
      assert.throws(() => answerRuleMessage(AGENT, key, {}), /invalid answer rule values/);
    }
  }
});
