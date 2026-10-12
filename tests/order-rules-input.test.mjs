/** Input-layer refusal sites (task file, call, CLI flags, order options, repository) build their text from the Plan_79 registry. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderGuidance } from '../cli/guidance-render.mjs';
import { ORDER_RULES, orderRuleMessage, orderRefusalAt } from '../src/home/lib/order-rules.mjs';
import { ORDER_DIAGNOSTICS, orderDiagnosticMessage } from '../src/home/lib/order-diagnostics.mjs';
import { parseTaskDocument } from '../src/home/lib/runner/task-file.mjs';
import { questionKindRefusal, questionsFromTexts } from '../src/home/lib/runner/question-kind.mjs';
import { repositoryRefusal } from '../src/home/lib/runner/task-input.mjs';
import { orderOptions } from '../src/home/lib/runner/order-options.mjs';
import { ADMISSION_FILES, PENDING_MIGRATION } from './order-guard/admission-files.mjs';
import { checkRefusalSites } from './order-guard/refusal-checker.mjs';
import { recordOrderText } from '../src/home/lib/order-text-record.mjs';

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

// Plan_79 B3b: these expectations copy args.mjs text, independent of the migrated builders.
const callRefusals = [
  ['task-file-path', { value: 'task.md' }, '--task-file must be an absolute path; got "task.md"'],
  ['task-file-path', { value: 'task "quoted"\n.md' },
    '--task-file must be an absolute path; got "task \\"quoted\\"\\n.md"'],
  ['task-body-required', { channel: 'task-file', taskFile: 'C:/task file.md' },
    'task file from --task-file is empty: C:/task file.md'],
  ['task-body-required', { channel: 'stdin' }, 'task text on stdin is empty'],
];
for (const [key, values, expected] of callRefusals) {
  test(key + ' preserves the call/task-file refusal: ' + expected, () => {
    assert.equal(orderRuleMessage(key, values), expected);
    assert.equal(ORDER_RULES[key].message(values), expected);
    assert.equal(ORDER_RULES[key].topic, 'order');
  });
}

const cliRefusals = [
  ['task-channel-conflict', {},
    'task text was supplied through both stdin and --task-file; choose exactly one channel'],
  ['unexpected-argument', { value: 'task text' }, 'unexpected argument: task text'],
  ['unknown-flag', { name: 'bogus' },
    'unknown flag --bogus: codex-bridge run takes only --agent, --task-file and --no-wait; ' +
      'the order belongs in the task-file header'],
  ['unknown-flag', { name: 'bogus', help: '' },
    'unknown flag --bogus: codex-bridge run takes only --agent, --task-file and --no-wait; ' +
      'the order belongs in the task-file header'],
  ['unknown-flag', { name: 'bogus', help: recordOrderText('Header help\nSecond line') },
    'unknown flag --bogus: codex-bridge run takes only --agent, --task-file and --no-wait; ' +
      'the order belongs in the task-file header\nHeader help\nSecond line'],
  ['boolean-flag-value', { name: 'no-wait', value: '<only if the orchestrator provided continue>' },
    '--no-wait takes no value, or one of 1/true/yes/0/false/no; got "<only if the orchestrator provided continue>". ' +
      'A placeholder left in from the prompt template is not consent.'],
  ['boolean-flag-value', { name: 'no-wait', value: '"yes"\n' },
    '--no-wait takes no value, or one of 1/true/yes/0/false/no; got "\\"yes\\"\\n". ' +
      'A placeholder left in from the prompt template is not consent.'],
  ['missing-flag-value', { key: '--agent' }, 'missing value for --agent'],
  ['flag-shell-safety', { name: 'agent', sequence: ';' },
    '--agent contains forbidden shell sequence ";"; put free text in the task file and pass only a short command-line value.'],
  ['flag-shell-safety', { name: 'task-file', sequence: '`' },
    '--task-file contains forbidden shell sequence "`"; put free text in the task file and pass only a short command-line value.'],
  ['agent-required', {}, '--agent is required'],
  ['agent-known', { agent: 'unknown' }, 'unknown --agent unknown'],
];
for (const [key, values, expected] of cliRefusals) {
  test(key + ' preserves the CLI diagnostic: ' + expected, () => {
    assert.equal(orderDiagnosticMessage(key, values), expected);
    assert.equal(ORDER_DIAGNOSTICS[key].message(values), expected);
    assert.equal(ORDER_DIAGNOSTICS[key].category, 'cli-flags');
  });
}

test('filesystem diagnostic preserves the caught read error verbatim', () => {
  const values = { message: 'ENOENT: no such file or directory, open \'C:/task file.md\'\nDetails' };
  const expected = 'task file from --task-file could not be read: ' +
    'ENOENT: no such file or directory, open \'C:/task file.md\'\nDetails';
  assert.equal(orderDiagnosticMessage('task-file-readable', values), expected);
  assert.equal(ORDER_DIAGNOSTICS['task-file-readable'].message(values), expected);
  assert.equal(ORDER_DIAGNOSTICS['task-file-readable'].category, 'filesystem');
});

test('location composition preserves forwarded header and section text without owning a rule', () => {
  assert.equal(orderRefusalAt('C:/task file.md', recordOrderText('line 1: duplicate scope label: scope: src/**\nNo quota.')),
    'C:/task file.md: line 1: duplicate scope label: scope: src/**\nNo quota.');
  assert.equal(orderRefusalAt('C:/task file.md', orderRuleMessage('verify-line', { violation: 'empty' })),
    'C:/task file.md: Verify section is empty');
});

test('task-body-required rejects absent and unknown channels instead of selecting one silently', () => {
  for (const channel of [undefined, 'unknown']) {
    assert.throws(() => orderRuleMessage('task-body-required', { channel }), {
      message: 'unknown task-body-required channel: ' + channel,
    });
  }
});

test('args.mjs is guarded after migration with no literal refusals or opt-outs', () => {
  const file = 'src/home/lib/runner/args.mjs';
  assert.ok(ADMISSION_FILES.includes(file));
  assert.ok(!PENDING_MIGRATION.has(file));
  const source = fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
  assert.deepEqual(checkRefusalSites(source, file), { violations: [], optOuts: [] });
});

test('call rules render once and replace the handwritten absolute task-file instruction', async () => {
  const source = fs.readFileSync(new URL('../src/home/guidance/order.md', import.meta.url), 'utf8');
  assert.ok(!source.includes('The path must be absolute and name a file the orchestrator wrote with its file tool.'));
  const text = await renderGuidance(source, {
    root: fileURLToPath(new URL('../src/home/', import.meta.url)), topic: 'order',
  });
  for (const key of ['task-file-path', 'task-body-required']) {
    assert.equal(text.split(ORDER_RULES[key].rule).length - 1, 1);
  }
});
