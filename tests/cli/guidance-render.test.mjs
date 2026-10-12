/** Plan_79 B1: installed modules own guidance values and broken templates fail loudly. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { renderGuidance } from '../../cli/guidance-render.mjs';
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
