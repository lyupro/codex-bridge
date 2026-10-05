import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ORDER_AGENTS, ALL_ORDER_LABELS, orderLabelsFor, orderInputName, orderFromHeader, renderOrderHeaderHelp, renderOrderProblems,
  CONTINUATION_ORDER_INPUT, RETRY_ORDER_INPUT,
} from '../src/home/lib/order-schema.mjs';
import { parseTaskHeader } from '../src/home/lib/task-header.mjs';

const expectedLabels = {
  'codex-scout': ['order id', 'continue', 'retry', 'repository', 'slug', 'effort'],
  'codex-build': ['order id', 'scope', 'continue', 'retry', 'repository', 'scope new', 'slug', 'effort'],
  'codex-review': ['order id', 'continue', 'retry', 'repository', 'slug', 'effort', 'changeset'],
  'codex-advisor': ['order id', 'continue', 'retry', 'phase', 'repository', 'slug', 'effort'],
};
const expectedOptionalAgents = {
  repository: ['codex-scout', 'codex-build', 'codex-review', 'codex-advisor'],
  'scope new': ['codex-build'],
  slug: ['codex-scout', 'codex-build', 'codex-review', 'codex-advisor'],
  effort: ['codex-scout', 'codex-build', 'codex-review', 'codex-advisor'],
  changeset: ['codex-review'],
};

test('order schemas own the immutable registry without call labels or runner fields (Plan_63 D9)', () => {
  assert.deepEqual(ORDER_AGENTS, ['codex-scout', 'codex-build', 'codex-review', 'codex-advisor']);
  assert.ok(Object.isFrozen(ORDER_AGENTS));
  for (const agent of ORDER_AGENTS) {
    const labels = orderLabelsFor(agent);
    assert.deepEqual(labels.map(({ label }) => label), expectedLabels[agent]);
    assert.ok(Object.isFrozen(labels));
    assert.ok(labels.every(Object.isFrozen));
    for (const entry of labels) {
      assert.equal(entry.required, ['order id', 'scope', 'phase'].includes(entry.label));
      assert.equal(entry.conditional, ['continue', 'retry'].includes(entry.label));
      assert.equal(entry.optional, Object.hasOwn(expectedOptionalAgents, entry.label));
      assert.equal(Object.hasOwn(entry, 'flag'), false);
      assert.equal(Object.hasOwn(entry, 'source'), false);
      assert.ok(entry.explanation.length > 0);
      assert.ok(entry.example.length > 0);
      if (entry.optional) {
        assert.deepEqual(entry.agents, expectedOptionalAgents[entry.label]);
        assert.ok(Object.isFrozen(entry.agents));
      }
    }
  }
  assert.deepEqual(ALL_ORDER_LABELS, [
    'changeset', 'continue', 'effort', 'order id', 'phase', 'repository', 'retry', 'scope', 'scope new', 'slug',
  ]);
  assert.equal(ALL_ORDER_LABELS.includes('task file'), false);
  assert.ok(Object.isFrozen(ALL_ORDER_LABELS));
  for (const agent of ['unknown', '__proto__', 'constructor']) {
    assert.deepEqual(orderLabelsFor(agent), []);
    assert.ok(Object.isFrozen(orderLabelsFor(agent)));
  }
});

test('grant and phase explanations name header authorization instead of flags (Plan_63 D9)', () => {
  for (const [entry, label, example] of [
    [CONTINUATION_ORDER_INPUT, 'continue', '2026-08-05_092913_plan14-build — LIMIT at step 3, tests unwritten'],
    [RETRY_ORDER_INPUT, 'retry', '2026-10-03_172017_cc-d66-advisor — model at capacity, same pass again'],
  ]) {
    assert.ok(Object.isFrozen(entry));
    assert.equal(entry.label, label);
    assert.equal(entry.example, example);
    assert.equal(entry.conditional, 'when this pass continues or repeats a named run');
    assert.equal(Object.hasOwn(entry, 'flag'), false);
    assert.equal(Object.hasOwn(entry, 'source'), false);
    assert.doesNotMatch(entry.explanation, /(^|\s)--[a-z]/);
  }
  assert.equal(orderLabelsFor('codex-advisor').find(({ label }) => label === 'phase').explanation,
    'Pass scope first to predict risks and check the reading boundary, then advise with a continue: grant naming the scope run of the same order.');
});

test('order input names use the header label spelling for every order label (Plan_63 D7)', () => {
  for (const label of ALL_ORDER_LABELS) assert.equal(orderInputName(label), `\`${label}:\``);
  assert.equal(orderInputName('continue'), '`continue:`');
  assert.equal(orderInputName('retry'), '`retry:`');
});

test('a blank order id and a codex-build scope without a pattern are header problems', () => {
  const header = (lines) => parseTaskHeader([...lines, '## Task', 'x'].join('\n'));
  const reasons = (agent, lines) => orderFromHeader(agent, header(lines)).problems.map(({ reason }) => reason);
  // A blank value never becomes a field, so the required-label check is what refuses it.
  assert.ok(reasons('codex-scout', ['order id:   ']).some((reason) => reason.startsWith('missing required header label "order id:"')));
  assert.ok(reasons('codex-build', ['order id: o-1', 'scope: , ,', 'scope new: src/new.mjs', 'advice: mechanical'])
    .some((reason) => reason.startsWith('`scope:` is required for codex-build')));
  assert.ok(!reasons('codex-build', ['order id: o-1', 'scope: src/a.mjs', 'advice: mechanical'])
    .some((reason) => reason.includes('is required')));
});

test('unknown order input labels throw an Error naming the label', () => {
  for (const label of ['unknown input', '__proto__', 'constructor']) {
    assert.throws(() => orderInputName(label), (error) =>
      error instanceof Error && error.message.includes(label));
  }
});

for (const agent of ORDER_AGENTS) {
  test(`${agent} reads a complete header without consuming its grant or advice`, () => {
    for (const grantLabel of ['continue', 'retry']) {
      const labels = orderLabelsFor(agent).filter(({ label }) => !['continue', 'retry'].includes(label));
      const text = labels.map(({ label, example }) => `${label}: ${example}`)
        .concat(`${grantLabel}: x — y`, 'advice: mechanical', '## Task').join('\n');
      const parsed = parseTaskHeader(text);
      const result = orderFromHeader(agent, parsed);
      assert.deepEqual(parsed.problems, []);
      assert.deepEqual(result.problems, []);
      assert.deepEqual(result.order, new Map(labels.map(({ label, example }) => [label, example])));
      assert.deepEqual(parsed.grant, { kind: grantLabel, run: 'x', reason: 'y' });
      assert.equal(parsed.advice, 'mechanical');
      assert.equal(parsed.body, '## Task');
    }
  });
}

test('missing required labels name the registry example with no source line', () => {
  for (const [agent, label] of [['codex-build', 'scope'], ['codex-advisor', 'phase']]) {
    const { example } = orderLabelsFor(agent).find((entry) => entry.label === label);
    const result = orderFromHeader(agent, parseTaskHeader('order id: plan-63'));
    assert.deepEqual(result.problems, [{ lineNo: null, line: '',
      reason: `missing required header label "${label}:"; example: ${label}: ${example}` }]);
  }
  for (const agent of ORDER_AGENTS) {
    const parsed = parseTaskHeader('## Task');
    const result = orderFromHeader(agent, parsed);
    const required = orderLabelsFor(agent).filter(({ required }) => required);
    assert.deepEqual(result.problems, required.map(({ label, example }) => ({
      lineNo: null, line: '',
      reason: `missing required header label "${label}:"; example: ${label}: ${example}`,
    })));
  }
});

test('a label rejected by the agent reports its original physical line', () => {
  const parsed = parseTaskHeader('order id: plan-63\r\nscope new: x\r\n## Task');
  const result = orderFromHeader('codex-scout', parsed);
  assert.deepEqual(result.order, new Map([['order id', 'plan-63']]));
  assert.deepEqual(result.problems, [{ lineNo: 2, line: 'scope new: x',
    reason: 'label "scope new" is not accepted by codex-scout' }]);
});

test('placeholder checks apply to order values; a placeholder grant is refused once, by the header', () => {
  const parsed = parseTaskHeader('order id: todo\nslug: tbd\ncontinue: none');
  // Plan_63 D1: the 2026-10-04 regression — `continue: none` must never count as a grant.
  assert.equal(parsed.grant, null);
  assert.equal(parsed.problems.filter(({ line }) => line === 'continue: none').length, 1);
  const result = orderFromHeader('codex-scout', parsed);
  assert.deepEqual(result.order, new Map([['order id', 'todo'], ['slug', 'tbd']]));
  assert.deepEqual(result.problems, ['order id', 'slug'].map((label, index) => ({
    lineNo: index + 1, line: ['order id: todo', 'slug: tbd'][index],
    reason: `label "${label}" is still a placeholder`,
  })));
});

test('effort none is a real value in the header, unlike none in other labels', () => {
  // Plan_63 D5: the flag channel accepted --effort none; the header channel must not refuse it.
  const result = orderFromHeader('codex-scout', parseTaskHeader('order id: plan-63\neffort: none\nslug: none'));
  assert.deepEqual(result.order, new Map([['order id', 'plan-63'], ['effort', 'none'], ['slug', 'none']]));
  assert.deepEqual(result.problems, [{ lineNo: 3, line: 'slug: none',
    reason: 'label "slug" is still a placeholder' }]);
});

test('schema validation never repeats header duplicate or grant problems', () => {
  const parsed = parseTaskHeader('order id: plan-63\norder id: another\ncontinue: x');
  assert.equal(parsed.problems.length, 2);
  const result = orderFromHeader('codex-scout', parsed);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.order, new Map([['order id', 'plan-63']]));
  assert.equal(parsed.grant, null);
});

test('placeholder diagnostics refer to the first duplicate value', () => {
  const result = orderFromHeader('codex-scout', parseTaskHeader('order id: todo\norder id: plan-63'));
  assert.deepEqual(result.problems, [{ lineNo: 1, line: 'order id: todo',
    reason: 'label "order id" is still a placeholder' }]);
});

test('unknown agents yield exactly one problem and no order', () => {
  for (const agent of ['unknown', '__proto__', 'constructor']) {
    const result = orderFromHeader(agent, parseTaskHeader('order id: plan-63'));
    assert.deepEqual(result.order, new Map());
    assert.deepEqual(result.problems, [{ lineNo: null, line: '',
      reason: `unknown dispatcher agent "${agent}"` }]);
  }
});

test('header help lists registry examples in required, conditional, optional order', () => {
  for (const agent of ORDER_AGENTS) {
    const labels = orderLabelsFor(agent);
    const expected = ['required', 'conditional', 'optional'].flatMap((category) =>
      labels.filter((entry) => entry[category]).map(({ label, example }) => `${label}: ${example}`));
    assert.equal(renderOrderHeaderHelp(agent), expected.join('\n'));
  }
  assert.equal(renderOrderHeaderHelp('unknown'), '');
});

test('order problem rendering preserves runner line diagnostics and the header template byte for byte', () => {
  const parsed = parseTaskHeader('scope: TODO\n## Task\nRequested task\n');
  const { problems } = orderFromHeader('codex-build', parsed);
  assert.equal(renderOrderProblems('codex-build', problems),
    'line 1: label "scope" is still a placeholder: scope: TODO\n'
      + 'missing required header label "order id:"; example: order id: plan-13-build-20260804\n'
      + renderOrderHeaderHelp('codex-build'));
});
