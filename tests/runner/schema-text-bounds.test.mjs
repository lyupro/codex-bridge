/** OW-068 / Plan_80 E21: every judged text constraint must be visible in the prompt. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { INSTRUCTIONS } from '../../src/home/lib/runner/prompts.mjs';
import { advisorSchema, schemaFor, SCHEMAS } from '../../src/home/lib/runner/schemas.mjs';

function renderedInstructions(agent, phase) {
  if (agent === 'codex-advisor') return INSTRUCTIONS[agent]({ phase });
  if (agent === 'codex-review') {
    return INSTRUCTIONS[agent]({}, { label: 'test scope', diffCommand: 'git diff', files: [] });
  }
  return INSTRUCTIONS[agent]({});
}

function* schemaNodes(schema, path = '') {
  yield { schema, path };
  if (schema.type === 'object') {
    for (const [name, child] of Object.entries(schema.properties ?? {})) {
      yield* schemaNodes(child, path ? `${path}.${name}` : name);
    }
  } else if (schema.type === 'array') {
    yield* schemaNodes(schema.items, `${path}[]`);
  }
}

const cases = Object.keys(INSTRUCTIONS).flatMap((agent) => agent === 'codex-advisor'
  ? ['scope', 'advise'].map((phase) => ({ agent, phase, schema: advisorSchema(phase) }))
  : [{ agent, schema: schemaFor(agent) }]);

for (const { agent, phase, schema } of cases) {
  test(`${agent}${phase ? `/${phase}` : ''} renders text rules and preserves array bounds`, () => {
    const prompt = renderedInstructions(agent, phase);
    const lines = prompt.split('\n');
    const nodes = [...schemaNodes(schema)];
    const expectedTextLines = [];
    for (const { schema: node, path } of nodes) {
      if (node.type !== 'string') continue;
      const matches = lines.filter((line) => line.startsWith(`- ${path}: `));
      if (!(node.minLength > 1) && node.pattern === undefined) {
        if (node.minLength === 1) assert.deepEqual(matches, [], `${path} has only minLength 1`);
        continue;
      }
      assert.equal(matches.length, 1, `${path} needs exactly one text rule`);
      const parts = [];
      if (node.minLength > 1) {
        assert.match(matches[0], new RegExp(`\\b${node.minLength}\\b`));
        parts.push(`at least ${node.minLength} characters`);
      }
      if (node.pattern !== undefined) {
        assert.ok(matches[0].includes(node.pattern), `${path} must show its literal pattern`);
        parts.push(`must match the pattern ${node.pattern}`);
      }
      expectedTextLines.push(`- ${path}: ${parts.join('; ')}`);
    }

    const textBlock = expectedTextLines.length
      ? `Output-schema text rules:\n${expectedTextLines.join('\n')}` : '';
    if (textBlock) assert.ok(prompt.endsWith(textBlock));
    else assert.ok(!prompt.includes('Output-schema text rules:'));

    const arrayLines = [];
    for (const { schema: node, path } of nodes) {
      if (node.type !== 'array' || (node.minItems === undefined && node.maxItems === undefined)) continue;
      const range = node.minItems !== undefined && node.maxItems !== undefined
        ? `${node.minItems}-${node.maxItems}`
        : node.minItems !== undefined ? `at least ${node.minItems}` : `at most ${node.maxItems}`;
      arrayLines.push(`- ${path}: ${range} ${(node.maxItems ?? node.minItems) === 1 ? 'item' : 'items'}`);
    }
    if (arrayLines.length) {
      const arrayBlock = `Output-schema array bounds:\n${arrayLines.join('\n')}`;
      assert.ok(prompt.endsWith(`${arrayBlock}${textBlock ? `\n\n${textBlock}` : ''}`),
        'unchanged array-bound block must immediately precede text rules');
      if (textBlock) assert.ok(prompt.indexOf(arrayBlock) < prompt.indexOf(textBlock));
    } else {
      assert.ok(!prompt.includes('Output-schema array bounds:'));
    }
  });
}

test('advisor advise states the exact counterargument minimum', () => {
  assert.ok(renderedInstructions('codex-advisor', 'advise').split('\n')
    .includes('- strongest_counterargument: at least 80 characters'));
});

test('text rules combine constraints and omit an empty block', () => {
  const original = SCHEMAS['codex-build'];
  try {
    SCHEMAS['codex-build'] = {
      type: 'object',
      properties: {
        entries: {
          type: 'array',
          items: {
            type: 'array',
            items: { type: 'string', minLength: 3, pattern: '^abc$' },
          },
        },
        nonempty: { type: 'string', minLength: 1 },
      },
    };
    assert.ok(renderedInstructions('codex-build').endsWith(
      'Output-schema text rules:\n- entries[][]: at least 3 characters; must match the pattern ^abc$',
    ));
    SCHEMAS['codex-build'] = {
      type: 'object', properties: { nonempty: { type: 'string', minLength: 1 } },
    };
    const prompt = renderedInstructions('codex-build');
    assert.ok(!prompt.includes('Output-schema text rules:'));
    assert.ok(!prompt.split('\n').some((line) => line.startsWith('- nonempty: ')));
  } finally {
    SCHEMAS['codex-build'] = original;
  }
});
