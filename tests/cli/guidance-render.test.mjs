/** Plan_79 B1: installed modules own guidance values and broken templates fail loudly. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { renderGuidance } from '../../cli/guidance-render.mjs';
import { AGENTS } from '../../src/home/lib/agents.mjs';
import { ORDER_RULES } from '../../src/home/lib/order-rules.mjs';
import { SHELL_UNSAFE_SEQUENCES } from '../../src/home/lib/shell-unsafe.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

function homeFixture(t) {
  const tree = makeTempTree('guidance-render-');
  t.after(() => removeTempTree(tree));
  const root = path.join(tree, 'installed home # Unicode-漢');
  fs.mkdirSync(root);
  return root;
}

function writeModule(root, file, source) {
  const target = path.join(root, 'lib', file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
}

function budgetFixture(t, extra = {}) {
  const root = homeFixture(t);
  for (const file of ['run-config.mjs', 'config-validate.mjs', 'budgets.mjs', 'brand-home.mjs']) {
    let source = fs.readFileSync(new URL(`../../src/home/lib/${file}`, import.meta.url), 'utf8');
    // Plan_80 E39: keep the real reader and validator against the isolated installed registry.
    for (const dependency of ['json-file.mjs', 'config-edit.mjs']) {
      source = source.replace(`'./${dependency}'`,
        JSON.stringify(new URL(`../../src/home/lib/${dependency}`, import.meta.url).href));
    }
    writeModule(root, file, source);
  }
  const registry = { ...AGENTS, ...extra };
  writeModule(root, 'agents.mjs', `export const AGENTS = ${JSON.stringify(registry)};`);
  return { root, registry, configPath: path.join(path.dirname(root), 'isolated-config.json') };
}

async function assertRenderFailure(text, root, topic, placeholder, reason) {
  await assert.rejects(renderGuidance(text, { root, topic }), (error) => {
    assert.ok(error.message.includes(`topic "${topic}"`));
    assert.ok(error.message.includes(`placeholder "${placeholder}"`));
    assert.match(error.message, reason);
    return true;
  });
}

const codeList = (values) => values.map((value) =>
  value.includes('`') ? '`` ' + value + ' ``' : '`' + value + '`').join(', ');

test('plain text preserves BOM, whitespace and line endings without loading modules', async (t) => {
  const text = '\uFEFF# plain\r\n\r\nDetailed rules — naïve.  \r\n';
  assert.equal(await renderGuidance(text, { root: homeFixture(t), topic: 'advisor' }), text);
});

test('every occurrence of a known placeholder uses the owned list', async (t) => {
  const root = homeFixture(t);
  const target = path.join(root, 'lib', 'shell-unsafe.mjs');
  fs.mkdirSync(path.dirname(target));
  fs.copyFileSync(new URL('../../src/home/lib/shell-unsafe.mjs', import.meta.url), target);
  const text = '{{shell-unsafe-sequences}}\n{{shell-unsafe-sequences}}';
  const expected = codeList(SHELL_UNSAFE_SEQUENCES);
  assert.equal(await renderGuidance(text, { root, topic: 'order' }), `${expected}\n${expected}`);
});

test('shell values come from the given installed root rather than the clone', async (t) => {
  const root = homeFixture(t);
  const values = ['installed-second', 'installed-first'];
  writeModule(root, 'shell-unsafe.mjs', `export const SHELL_UNSAFE_SEQUENCES = ${JSON.stringify(values)};`);
  assert.notDeepEqual(values, SHELL_UNSAFE_SEQUENCES);
  assert.equal(await renderGuidance('{{shell-unsafe-sequences}}', { root, topic: 'order' }), codeList(values));
});

test('backtick values use spaced double delimiters without opening a code fence', async (t) => {
  const root = homeFixture(t);
  const values = ['`', 'before`after', '&&'];
  writeModule(root, 'shell-unsafe.mjs', `export const SHELL_UNSAFE_SEQUENCES = ${JSON.stringify(values)};`);
  const output = await renderGuidance('{{shell-unsafe-sequences}}', { root, topic: 'order' });
  assert.equal(output, '`` ` ``, `` before`after ``, `&&`');
  assert.doesNotMatch(output, /`{3}/);
});

test('both review field lists come from the given installed schema', async (t) => {
  const root = homeFixture(t);
  const fields = ['installed-summary', 'installed-verdict'];
  const finding = ['installed-body', 'installed-title'];
  const schema = { required: fields, properties: { findings: { items: { required: finding } } } };
  writeModule(root, 'runner/schemas.mjs', `export const SCHEMAS = ${JSON.stringify({ 'codex-review': schema })};`);
  assert.equal(await renderGuidance('{{review-required-fields}}', { root, topic: 'records' }),
    `Top-level fields: ${codeList(fields)}; finding fields: ${codeList(finding)}`);
});

test('unknown placeholders including inherited names fail with their topic and token', async (t) => {
  const root = homeFixture(t);
  for (const name of ['unknown', 'constructor', '__proto__', '']) {
    const placeholder = `{{${name}}}`;
    await assertRenderFailure(placeholder, root, 'order', placeholder, /unknown placeholder/);
  }
});

test('unclosed and nested placeholders fail rather than leaking template syntax', async (t) => {
  const root = homeFixture(t);
  for (const placeholder of ['{{', '{{shell-unsafe-sequences}', '{{nested{value}}']) {
    await assertRenderFailure(`Rules: ${placeholder}\nEnd`, root, 'order', placeholder, /unresolved placeholder/);
  }
});

test('a missing installed shell module fails without a clone fallback', async (t) => {
  await assertRenderFailure('{{shell-unsafe-sequences}}', homeFixture(t), 'order',
    '{{shell-unsafe-sequences}}', /Cannot find module/);
});

test('a failed installed schema import names the review placeholder', async (t) => {
  const root = homeFixture(t);
  writeModule(root, 'runner/schemas.mjs', "throw new Error('installed schema import failed');");
  await assertRenderFailure('{{review-required-fields}}', root, 'records',
    '{{review-required-fields}}', /installed schema import failed/);
});

test('missing owned exports fail instead of supplying a default list', async (t) => {
  const root = homeFixture(t);
  writeModule(root, 'shell-unsafe.mjs', 'export const unrelated = [];');
  await assertRenderFailure('{{shell-unsafe-sequences}}', root, 'order',
    '{{shell-unsafe-sequences}}', /map/);
});

test('template syntax introduced by an installed value also fails', async (t) => {
  const root = homeFixture(t);
  writeModule(root, 'shell-unsafe.mjs', 'export const SHELL_UNSAFE_SEQUENCES = ["{{installed-value}}"]');
  await assertRenderFailure('{{shell-unsafe-sequences}}', root, 'order',
    '{{installed-value}}`', /unresolved placeholder/);
});

test('order rule placeholders use the installed root and preserve registry order within a topic', async (t) => {
  const root = homeFixture(t);
  const rules = {
    'installed-second': { topic: 'advisor', rule: 'Second by name, first in the registry.' },
    'other-topic': { topic: 'order', rule: 'Only in the all block.' },
    'installed-first': { topic: 'advisor', rule: 'First by name, second in the registry.' },
  };
  writeModule(root, 'order-rules.mjs', `export const ORDER_RULES = ${JSON.stringify(rules)};`);
  assert.notDeepEqual(rules, ORDER_RULES);
  const expected = '- `installed-second`: Second by name, first in the registry.\n' +
    '- `installed-first`: First by name, second in the registry.';
  assert.equal(await renderGuidance('{{order-rules:advisor}}\n{{order-rules:advisor}}', { root, topic: 'advisor' }),
    `${expected}\n${expected}`);
  assert.equal(await renderGuidance('{{order-rules:all}}', { root, topic: 'order' }),
    'Topic `order`:\n- `other-topic`: Only in the all block.\n\nTopic `advisor`:\n' + expected);
});

test('all order rules follow the guidance topic order and omit topics without rules', async (t) => {
  const root = homeFixture(t);
  const rules = {
    'concurrency-rule': { topic: 'concurrency', rule: 'Concurrency rule.' },
    'records-rule': { topic: 'records', rule: 'Records rule.' },
    'budget-rule': { topic: 'budget', rule: 'Budget rule.' },
    'advisor-rule': { topic: 'advisor', rule: 'Advisor rule.' },
    'order-rule': { topic: 'order', rule: 'Order rule.' },
  };
  writeModule(root, 'order-rules.mjs', `export const ORDER_RULES = ${JSON.stringify(rules)};`);
  assert.equal(await renderGuidance('{{order-rules:all}}', { root, topic: 'order' }),
    ['order', 'advisor', 'budget', 'records', 'concurrency'].map((topic) =>
      `Topic \`${topic}\`:\n- \`${topic}-rule\`: ${rules[`${topic}-rule`].rule}`).join('\n\n'));
});

test('unknown order rule topics including inherited names fail with their topic and token', async (t) => {
  const root = homeFixture(t);
  for (const name of ['unknown', 'constructor', '__proto__', '']) {
    const placeholder = `{{order-rules:${name}}}`;
    await assertRenderFailure(placeholder, root, 'order', placeholder, /unknown order rule topic/);
  }
});

test('a known topic with no order rules fails instead of printing an empty block', async (t) => {
  const root = homeFixture(t);
  writeModule(root, 'order-rules.mjs', 'export const ORDER_RULES = { "order-rule": { topic: "order", rule: "Order rule." } };');
  await assertRenderFailure('{{order-rules:budget}}', root, 'budget', '{{order-rules:budget}}', /no order rules/);
});

test('an empty order registry fails for both all and topic placeholders', async (t) => {
  const root = homeFixture(t);
  writeModule(root, 'order-rules.mjs', 'export const ORDER_RULES = {};');
  for (const placeholder of ['{{order-rules:all}}', '{{order-rules:order}}']) {
    await assertRenderFailure(placeholder, root, 'order', placeholder, /no order rules/);
  }
});

test('a missing installed order registry fails without a clone fallback', async (t) => {
  await assertRenderFailure('{{order-rules:all}}', homeFixture(t), 'order',
    '{{order-rules:all}}', /Cannot find module/);
});

test('missing order rule exports fail instead of supplying a default registry', async (t) => {
  const root = homeFixture(t);
  writeModule(root, 'order-rules.mjs', 'export const unrelated = {};');
  await assertRenderFailure('{{order-rules:all}}', root, 'order',
    '{{order-rules:all}}', /undefined|null/);
});

test('budget rows follow the installed registry and effective host phase sources', async (t) => {
  const { root, configPath } = budgetFixture(t, {
    'installed-extra-agent': { role: 'unrelated-role', budget: { prepare: 4, finish: 9 } },
    'installed-single-phase': { role: 'named-role', budget: { only: 6 } },
  });
  fs.writeFileSync(configPath, JSON.stringify({ budgets: {
    scout: AGENTS['codex-scout'].budget, build: 7.5, review: {}, advisor: { advise: 12 },
    'unrelated-role': { prepare: 3 },
  } }));
  const output = await renderGuidance('{{agent-budgets}}', { root, topic: 'budget', configPath });
  assert.equal(output, [
    `Budgets the runner enforces on this host. \`host config\` values come from ${configPath}.`,
    '', '| Agent | Phase | Minutes | Source |', '| --- | --- | --- | --- |',
    `| codex-scout | \u2014 | ${AGENTS['codex-scout'].budget} | host config |`,
    '| codex-build | \u2014 | 7.5 | host config |',
    `| codex-review | \u2014 | ${AGENTS['codex-review'].budget} | package |`,
    `| codex-advisor | scope | ${AGENTS['codex-advisor'].budget.scope} | package |`,
    '| codex-advisor | advise | 12 | host config |',
    '| installed-extra-agent | prepare | 3 | host config |',
    '| installed-extra-agent | finish | 9 | package |',
    '| installed-single-phase | \u2014 | 6 | package |',
  ].join('\n'));
  assert.equal(await renderGuidance('{{agent-budgets}}\n{{agent-budgets}}',
    { root, topic: 'budget', configPath }), `${output}\n${output}`);
});

test('a missing config renders every package budget from the installed registry', async (t) => {
  const { root, registry, configPath } = budgetFixture(t, {
    'extra-budget-agent': { role: 'extra-budget-role', budget: 8 },
  });
  const output = await renderGuidance('{{agent-budgets}}', { root, topic: 'budget', configPath });
  const rows = [];
  for (const [agent, { budget }] of Object.entries(registry)) {
    const phases = typeof budget === 'number' ? { default: budget } : budget;
    for (const [phase, minutes] of Object.entries(phases)) {
      rows.push(`| ${agent} | ${Object.keys(phases).length === 1 ? '\u2014' : phase} | ${minutes} | package |`);
    }
  }
  assert.deepEqual(output.split('\n').slice(4), rows);
  assert.doesNotMatch(output, /\| host config \|/);
});

test('broken configs fail with budget topic and placeholder context instead of defaults', async (t) => {
  for (const content of ['{"budgets":', '{"budgets":{"advisor":7}}']) {
    const { root, configPath } = budgetFixture(t);
    fs.writeFileSync(configPath, content);
    await assert.rejects(renderGuidance('{{agent-budgets}}', { root, topic: 'budget', configPath }),
      (error) => {
        assert.equal(Object.hasOwn(error, 'hostConfig'), true);
        assert.equal(error.hostConfig, true);
        assert.ok(error.message.startsWith('Cannot render guidance topic "budget" placeholder "{{agent-budgets}}": '));
        assert.ok(error.message.includes(configPath));
        assert.match(error.message, /cannot be parsed as JSON|must be a phase map/);
        assert.doesNotMatch(error.message, /\| package \|/);
        return true;
      });
  }
});

test('a missing installed agent module is not a host config failure', async (t) => {
  const root = homeFixture(t);
  const configPath = path.join(root, 'config.json');
  await assert.rejects(renderGuidance('{{agent-budgets}}', { root, topic: 'budget', configPath }),
    (error) => {
      assert.equal(Object.hasOwn(error, 'hostConfig'), false);
      assert.equal(error.hostConfig, undefined);
      assert.match(error.message, /Cannot find module/);
      assert.ok(error.message.includes('placeholder "{{agent-budgets}}"'));
      return true;
    });
});

test('budget rendering requires configPath instead of using the real host config', async (t) => {
  await assertRenderFailure('{{agent-budgets}}', homeFixture(t), 'budget',
    '{{agent-budgets}}', /configPath is required/);
});

test('budget guidance owns no handwritten budget values', () => {
  const text = fs.readFileSync(new URL('../../src/home/guidance/budget.md', import.meta.url), 'utf8');
  assert.ok(text.includes('{{agent-budgets}}'));
  assert.doesNotMatch(text, /\| Agent \||\d+(?:\.\d+)?\s*minutes/);
  assert.match(text, /within the same build budget shown above/);
});
