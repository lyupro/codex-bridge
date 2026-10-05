import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REQUIRED_INPUTS, callInputsFor } from '../src/home/lib/required-inputs.mjs';
import {
  ORDER_AGENTS, ALL_ORDER_LABELS, orderLabelsFor, orderFromHeader, renderOrderHeaderHelp,
} from '../src/home/lib/order-schema.mjs';
import { parseTaskHeader } from '../src/home/lib/task-header.mjs';

test('order schemas derive every label and its category from the registry minus task file', () => {
  assert.deepEqual(ORDER_AGENTS, Object.keys(REQUIRED_INPUTS));
  assert.ok(Object.isFrozen(ORDER_AGENTS));
  for (const agent of ORDER_AGENTS) {
    const expected = callInputsFor(agent).filter(({ label }) => label !== 'task file');
    const labels = orderLabelsFor(agent);
    assert.deepEqual(labels, expected.map((entry) => ({
      label: entry.label,
      required: !entry.conditional && !entry.optional,
      conditional: Boolean(entry.conditional),
      optional: Boolean(entry.optional),
      example: entry.example,
    })));
    assert.ok(Object.isFrozen(labels));
    assert.ok(labels.every(Object.isFrozen));
  }
  assert.deepEqual(ALL_ORDER_LABELS, [...new Set(ORDER_AGENTS.flatMap((agent) =>
    callInputsFor(agent).filter(({ label }) => label !== 'task file').map(({ label }) => label),
  ))].sort());
  assert.ok(Object.isFrozen(ALL_ORDER_LABELS));
  for (const agent of ['unknown', '__proto__', 'constructor']) {
    assert.deepEqual(orderLabelsFor(agent), []);
    assert.ok(Object.isFrozen(orderLabelsFor(agent)));
  }
});

for (const agent of ORDER_AGENTS) {
  test(`${agent} reads a complete header without consuming its grant or advice`, () => {
    for (const grantLabel of ['continue', 'retry']) {
      const labels = callInputsFor(agent).filter(({ label }) =>
        label !== 'task file' && !['continue', 'retry'].includes(label));
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
    const { example } = callInputsFor(agent).find((entry) => entry.label === label);
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
