/** Guards the Plan_79 D3 registry contract before any refusal site is migrated. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GUIDANCE_TOPICS } from '../cli/guidance-topics.mjs';
import {
  ORDER_RULES, orderRuleMessage, validateOrderRules,
} from '../src/home/lib/order-rules.mjs';
import {
  DIAGNOSTIC_CATEGORIES, ORDER_DIAGNOSTICS, orderDiagnosticMessage, validateOrderDiagnostics,
} from '../src/home/lib/order-diagnostics.mjs';
import { parseTaskDocument } from '../src/home/lib/runner/task-file.mjs';
import { questionKindRefusal, questionsFromTexts } from '../src/home/lib/runner/question-kind.mjs';
import { repositoryRefusal } from '../src/home/lib/runner/task-input.mjs';
import { orderOptions } from '../src/home/lib/runner/order-options.mjs';

test('registry maps and entries are frozen and have exactly their contracted fields', () => {
  assert.ok(Object.isFrozen(ORDER_RULES));
  assert.ok(Object.isFrozen(ORDER_DIAGNOSTICS));
  assert.deepEqual(Object.keys(ORDER_RULES).sort(), [
    'effort-value', 'question-context-marker', 'repository-path', 'run-slug', 'scout-questions', 'verify-line',
  ]);
  for (const entry of Object.values(ORDER_RULES)) {
    assert.ok(Object.isFrozen(entry));
    assert.deepEqual(Object.keys(entry).sort(), ['message', 'rule', 'topic']);
    assert.equal(typeof entry.message, 'function');
  }
  for (const entry of Object.values(ORDER_DIAGNOSTICS)) {
    assert.ok(Object.isFrozen(entry));
    assert.deepEqual(Object.keys(entry).sort(), ['category', 'message']);
    assert.equal(typeof entry.message, 'function');
  }
  assert.deepEqual(Object.keys(ORDER_DIAGNOSTICS), ['no-wait-grant-conflict']);
  assert.equal(ORDER_DIAGNOSTICS['no-wait-grant-conflict'].category, 'cli-flags');
});

test('keys are kebab-case and unique across the two registries', () => {
  const keys = [...Object.keys(ORDER_RULES), ...Object.keys(ORDER_DIAGNOSTICS)];
  for (const key of keys) assert.match(key, /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
  assert.equal(new Set(keys).size, keys.length);
});

test('rule topics exist in GUIDANCE_TOPICS and rule text is non-empty without placeholders', () => {
  for (const entry of Object.values(ORDER_RULES)) {
    assert.ok(Object.hasOwn(GUIDANCE_TOPICS, entry.topic));
    assert.equal(typeof entry.rule, 'string');
    assert.ok(entry.rule.trim());
    assert.ok(!entry.rule.includes('{{'));
  }
  assert.doesNotThrow(() => validateOrderRules(ORDER_RULES, GUIDANCE_TOPICS, ORDER_DIAGNOSTICS));
});

test('diagnostic categories are closed and frozen', () => {
  assert.ok(Object.isFrozen(DIAGNOSTIC_CATEGORIES));
  assert.deepEqual(DIAGNOSTIC_CATEGORIES, [
    'cli-flags', 'filesystem', 'host-state', 'run-state', 'internal',
  ]);
  for (const entry of Object.values(ORDER_DIAGNOSTICS)) {
    assert.ok(DIAGNOSTIC_CATEGORIES.includes(entry.category));
  }
  assert.doesNotThrow(() => validateOrderDiagnostics(ORDER_DIAGNOSTICS));
  for (const category of DIAGNOSTIC_CATEGORIES) {
    assert.doesNotThrow(() => validateOrderDiagnostics({
      'sample-diagnostic': { category, message: () => 'sample' },
    }));
  }
});

for (const key of ['missing-rule', 'toString', 'constructor', '__proto__']) {
  test(`unknown key ${key} throws a programming error in both helpers`, () => {
    assert.throws(() => orderRuleMessage(key), {
      name: 'Error', message: `unknown order rule: ${key}`,
    });
    assert.throws(() => orderDiagnosticMessage(key), {
      name: 'Error', message: `unknown order diagnostic: ${key}`,
    });
  });
}

const sampleRule = { topic: 'order', rule: 'Write an order.', message: () => 'sample' };
const invalidRules = [
  ['unknown topic', { ...sampleRule, topic: 'unknown' }, 'unknown order rule topic: sample-rule'],
  ['inherited topic', { ...sampleRule, topic: 'toString' }, 'unknown order rule topic: sample-rule'],
  ['empty rule', { ...sampleRule, rule: '' }, 'invalid order rule text: sample-rule'],
  ['blank rule', { ...sampleRule, rule: ' \t\n' }, 'invalid order rule text: sample-rule'],
  ['non-string rule', { ...sampleRule, rule: 1 }, 'invalid order rule text: sample-rule'],
  ['placeholder', { ...sampleRule, rule: 'Use {{root}}.' }, 'invalid order rule text: sample-rule'],
  ['extra field', { ...sampleRule, extra: true }, 'invalid order rule entry: sample-rule'],
  ['missing field', { topic: 'order', message: () => 'sample' }, 'invalid order rule entry: sample-rule'],
  ['non-function message', { ...sampleRule, message: 'sample' }, 'invalid order rule message: sample-rule'],
];
for (const [label, entry, message] of invalidRules) {
  test(`rule validator rejects ${label}`, () => {
    assert.throws(() => validateOrderRules({ 'sample-rule': entry }, GUIDANCE_TOPICS, {}), { message });
  });
}

test('rule validator rejects a duplicate key across modules', () => {
  assert.throws(() => validateOrderRules(
    { 'sample-rule': sampleRule }, GUIDANCE_TOPICS,
    { 'sample-rule': { category: 'internal', message: () => 'sample' } },
  ), { message: 'duplicate order key: sample-rule' });
});

for (const key of ['Bad-key', 'bad_key', 'bad--key', '-bad', 'bad-', '1-bad']) {
  test(`both validators reject non-kebab key ${key}`, () => {
    assert.throws(() => validateOrderRules({ [key]: sampleRule }, GUIDANCE_TOPICS, {}), {
      message: `invalid order rule key: ${key}`,
    });
    assert.throws(() => validateOrderDiagnostics({
      [key]: { category: 'internal', message: () => 'sample' },
    }), { message: `invalid order diagnostic key: ${key}` });
  });
}

const invalidDiagnostics = [
  ['unknown category', { category: 'unknown', message: () => 'sample' },
    'unknown order diagnostic category: sample-diagnostic'],
  ['extra field', { category: 'internal', message: () => 'sample', extra: true },
    'invalid order diagnostic entry: sample-diagnostic'],
  ['missing field', { message: () => 'sample' }, 'invalid order diagnostic entry: sample-diagnostic'],
  ['non-function message', { category: 'internal', message: 'sample' },
    'invalid order diagnostic message: sample-diagnostic'],
];
for (const [label, entry, message] of invalidDiagnostics) {
  test(`diagnostic validator rejects ${label}`, () => {
    assert.throws(() => validateOrderDiagnostics({ 'sample-diagnostic': entry }), { message });
  });
}

// These literals are the current task-file refusals, including JSON quoting and trimming.
const taskRefusals = [
  ['scout-questions', { violation: 'non-list-line', line: '  This is not a list item  ' },
    '## Questions\n  This is not a list item  ',
    'Questions section contains a non-list line: "This is not a list item"'],
  ['scout-questions', { violation: 'non-list-line', line: ' Use "quoted" text ' },
    '## Questions\n Use "quoted" text ',
    'Questions section contains a non-list line: "Use \\"quoted\\" text"'],
  ['scout-questions', { violation: 'empty' }, '## Questions\n\n', 'Questions section is empty'],
  ['verify-line', { violation: 'empty' }, '## Verify\n\n', 'Verify section is empty'],
  ['verify-line', { violation: 'multiple-lines' }, '## Verify\nnpm test\nnpm run lint',
    'Verify section must contain exactly one non-empty line'],
];
for (const [key, values, document, expected] of taskRefusals) {
  test(`${key} reproduces the task-file refusal: ${expected}`, () => {
    assert.equal(orderRuleMessage(key, values), expected);
    assert.equal(ORDER_RULES[key].message(values), expected);
    assert.throws(() => parseTaskDocument(document), { message: expected });
  });
}

// The marker's placement/spelling branch and its missing-whitespace/text branch share one key.
const markerRefusals = [
  [0, '[Context-Only] x', 'Q1 has an invalid context-only marker in "[Context-Only] x"'],
  [1, 'x [context-only]', 'Q2 has an invalid context-only marker in "x [context-only]"'],
  [1, '[context-only] a [context-only] b',
    'Q2 has an invalid context-only marker in "[context-only] a [context-only] b"'],
  [9, '[context-only]x', 'Q10 has an invalid context-only marker in "[context-only]x"'],
  [0, '[context-only]', 'Q1 has an invalid context-only marker in "[context-only]"'],
  [1, '[context-only]\t\n', 'Q2 has an invalid context-only marker in "[context-only]\\t\\n"'],
  [1, '"quoted" [context-only]',
    'Q2 has an invalid context-only marker in "\\"quoted\\" [context-only]"'],
];
for (const [index, text, expected] of markerRefusals) {
  test(`question-context-marker reproduces the refusal: ${expected}`, () => {
    const texts = [...Array(index).fill('An ordinary question.'), text];
    assert.equal(orderRuleMessage('question-context-marker', { index, text }), expected);
    assert.equal(questionKindRefusal(texts), expected);
    assert.throws(() => questionsFromTexts(texts), { message: expected });
  });
}

// Plan_79 B3a: keep literal expectations independent of the builders moved out of admission files.
const optionRefusals = [
  ['effort-value', 'effort', '', 'must be a non-empty single word with no whitespace; got ""'],
  ['effort-value', 'effort', 'extra high',
    'must be a non-empty single word with no whitespace; got "extra high"'],
  ['effort-value', 'effort', 'high\n',
    'must be a non-empty single word with no whitespace; got "high\\n"'],
  ['run-slug', 'slug', '---',
    'produces an unusable run folder name after sanitization: "---" must contain a letter or digit.'],
  ['run-slug', 'order id', '_..',
    'produces an unusable run folder name after sanitization: "_.." must contain a letter or digit.'],
];
for (const [key, label, value, expected] of optionRefusals) {
  test(`${key} preserves the ${label} refusal for ${JSON.stringify(value)}`, () => {
    assert.equal(orderRuleMessage(key, { value }), expected);
    assert.equal(ORDER_RULES[key].message({ value }), expected);
    const order = new Map([['order id', 'valid-id'], [label, value]]);
    assert.deepEqual(orderOptions('codex-build', order).problems, [{ label, reason: expected }]);
  });
}

const repositoryRefusals = [
  ['relative', 'relative/repo', undefined,
    'must be an absolute path to the repository; got "relative/repo".',
    '`repository:` must be an absolute path to the repository; got "relative/repo".\n' +
      'The run folder was not created; quota was not spent.'],
  ['altered-segment', '/repo./child', 'repo.',
    'has a path segment ending in a dot or a space ("repo."), which Windows strips; got "/repo./child".',
    '`repository:` has a path segment ending in a dot or a space ("repo."), which Windows strips; got "/repo./child".\n' +
      'The run folder was not created; quota was not spent.'],
  ['altered-segment', '/repo /child', 'repo ',
    'has a path segment ending in a dot or a space ("repo "), which Windows strips; got "/repo /child".',
    '`repository:` has a path segment ending in a dot or a space ("repo "), which Windows strips; got "/repo /child".\n' +
      'The run folder was not created; quota was not spent.'],
  ['not-directory', '/plan79-b3a-missing-repository', undefined,
    'must name an existing directory; "/plan79-b3a-missing-repository" is not one.',
    '`repository:` must name an existing directory; "/plan79-b3a-missing-repository" is not one.\n' +
      'The run folder was not created; quota was not spent.'],
];
for (const [violation, value, segment, expected, fullExpected] of repositoryRefusals) {
  test(`repository-path preserves the ${violation} reason and admission suffix for ${value}`, () => {
    assert.equal(orderRuleMessage('repository-path', { violation, value, segment }), expected);
    assert.equal(repositoryRefusal(value), expected);
    assert.equal(orderRuleMessage('repository-path', {
      context: 'task-input', label: '`repository:`', reason: expected,
    }), fullExpected);
  });
}

test('scout-questions preserves the required sub-question refusal', () => {
  assert.equal(orderRuleMessage('scout-questions', { violation: 'missing' }),
    'a sub-question is required for codex-scout: put one Markdown list item per sub-question ' +
      'under a `Questions` heading in the task document. ' +
      'The runner will not infer questions from the task text; no quota was spent.');
  assert.match(ORDER_RULES['scout-questions'].rule, /For codex-scout, include a non-empty Questions section/);
});

const contextualMarkerRefusals = [
  ['[Context-Only] x',
    'Q1 has an invalid context-only marker in "[Context-Only] x"; the marker is exactly [context-only] ' +
      'followed by a space and the question; no quota was spent.'],
  ['[context-only]x',
    'Q1 has an invalid context-only marker in "[context-only]x"; the marker is exactly [context-only] ' +
      'followed by a space and the question; no quota was spent.'],
  ['[context-only]\t\n',
    'Q1 has an invalid context-only marker in "[context-only]\\t\\n"; the marker is exactly [context-only] ' +
      'followed by a space and the question; no quota was spent.'],
];
for (const [text, expected] of contextualMarkerRefusals) {
  test(`question-context-marker preserves the task-input suffix for ${JSON.stringify(text)}`, () => {
    assert.equal(orderRuleMessage('question-context-marker', {
      context: 'task-input', refusal: questionKindRefusal([text]),
    }), expected);
  });
}

for (const [grant, expected] of [
  ['`continue:`', '--no-wait cannot be combined with a `continue:` grant: ' +
    'checking an existing run must never authorize a new one.'],
  ['`retry:`', '--no-wait cannot be combined with a `retry:` grant: ' +
    'checking an existing run must never authorize a new one.'],
]) {
  test(`no-wait-grant-conflict preserves the ${grant} diagnostic`, () => {
    assert.equal(orderDiagnosticMessage('no-wait-grant-conflict', { grant }), expected);
    assert.equal(ORDER_DIAGNOSTICS['no-wait-grant-conflict'].message({ grant }), expected);
  });
}

test('contextual message functions reject unknown contexts', () => {
  for (const key of ['repository-path', 'question-context-marker']) {
    assert.throws(() => orderRuleMessage(key, { context: 'unknown' }), {
      message: `unknown ${key} context: unknown`,
    });
  }
});

test('grouped message functions reject unknown violations instead of choosing a refusal silently', () => {
  for (const key of ['scout-questions', 'verify-line', 'repository-path']) {
    assert.throws(() => orderRuleMessage(key, { violation: 'unknown' }), {
      message: `unknown ${key} violation: unknown`,
    });
    assert.throws(() => orderRuleMessage(key), {
      message: `unknown ${key} violation: undefined`,
    });
  }
});
