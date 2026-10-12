/** Plan_79 D4: ownership must survive registry growth and installation without silent overwrites. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as ruleRegistry from '../src/home/lib/order-rules.mjs';
import * as diagnosticRegistry from '../src/home/lib/order-diagnostics.mjs';
import { makeTempTree, removeTempTree } from './temp-tree.mjs';

const { ORDER_RULES } = ruleRegistry;
const { DIAGNOSTIC_CATEGORIES, ORDER_DIAGNOSTICS } = diagnosticRegistry;
const lib = fileURLToPath(new URL('../src/home/lib/', import.meta.url));
const ruleKeys = [
  'effort-value', 'run-slug', 'repository-path',
  'scout-questions', 'question-context-marker', 'verify-line',
];

function moduleFiles(directory) {
  return fs.readdirSync(directory, { recursive: true }).filter((file) => file.endsWith('.mjs')).sort();
}

function copyRegistry(t, name) {
  const tree = makeTempTree('order-registry-layout-');
  t.after(() => removeTempTree(tree));
  const home = path.join(tree, 'installed home # Unicode-漢');
  const installedLib = path.join(home, 'lib');
  fs.mkdirSync(installedLib, { recursive: true });
  const entryPoint = path.join(installedLib, `${name}.mjs`);
  fs.copyFileSync(path.join(lib, `${name}.mjs`), entryPoint);
  fs.cpSync(path.join(lib, name), path.join(installedLib, name), { recursive: true });
  return { home, installedLib, entryPoint };
}

test('entry points preserve their exports and fixed registry order', () => {
  assert.deepEqual(Object.keys(ruleRegistry), ['ORDER_RULES', 'orderRuleMessage', 'validateOrderRules']);
  assert.deepEqual(Object.keys(diagnosticRegistry), [
    'DIAGNOSTIC_CATEGORIES', 'ORDER_DIAGNOSTICS', 'orderDiagnosticMessage', 'validateOrderDiagnostics',
  ]);
  assert.deepEqual(Object.keys(ORDER_RULES), ruleKeys);
  assert.deepEqual(Object.keys(ORDER_DIAGNOSTICS), ['no-wait-grant-conflict']);
  assert.ok(Object.isFrozen(ORDER_RULES));
  assert.ok(Object.isFrozen(ORDER_DIAGNOSTICS));
});

test('every place module is frozen, non-empty, wired in and the sole owner of each key', async () => {
  const directory = path.join(lib, 'order-rules');
  const owners = new Map();
  for (const file of moduleFiles(directory)) {
    const module = await import(pathToFileURL(path.join(directory, file)).href);
    assert.deepEqual(Object.keys(module), ['RULES'], file);
    assert.ok(Object.isFrozen(module.RULES), file);
    assert.ok(Object.keys(module.RULES).length > 0, `${file} must not be empty`);
    for (const [key, entry] of Object.entries(module.RULES)) {
      assert.ok(!owners.has(key), `${key} belongs to both ${owners.get(key)} and ${file}`);
      owners.set(key, file);
      assert.ok(Object.hasOwn(ORDER_RULES, key), `${file}: ${key} is not wired into the entry point`);
      assert.equal(ORDER_RULES[key], entry, `${file}: ${key} must use the owned entry`);
      assert.ok(Object.isFrozen(entry), key);
    }
  }
  assert.deepEqual([...owners.keys()].sort(), Object.keys(ORDER_RULES).sort());
  for (const key of ruleKeys.slice(0, 3)) assert.equal(owners.get(key), 'header.mjs');
  for (const key of ruleKeys.slice(3)) assert.equal(owners.get(key), 'task-document.mjs');
  assert.ok(!fs.existsSync(path.join(directory, 'call.mjs')), 'call.mjs waits for its first rule');
});

test('every diagnostic file owns its named category and is wired in without duplicate keys', async () => {
  const directory = path.join(lib, 'order-diagnostics');
  const owners = new Map();
  for (const file of moduleFiles(directory)) {
    const category = file.slice(0, -'.mjs'.length);
    assert.ok(DIAGNOSTIC_CATEGORIES.includes(category), `${file} must be named after a category`);
    const module = await import(pathToFileURL(path.join(directory, file)).href);
    assert.deepEqual(Object.keys(module), ['DIAGNOSTICS'], file);
    assert.ok(Object.isFrozen(module.DIAGNOSTICS), file);
    assert.ok(Object.keys(module.DIAGNOSTICS).length > 0, `${file} must not be empty`);
    for (const [key, entry] of Object.entries(module.DIAGNOSTICS)) {
      assert.equal(entry.category, category, `${file}: ${key} belongs to another category`);
      assert.ok(!owners.has(key), `${key} belongs to both ${owners.get(key)} and ${file}`);
      owners.set(key, file);
      assert.ok(Object.hasOwn(ORDER_DIAGNOSTICS, key), `${file}: ${key} is not wired into the entry point`);
      assert.equal(ORDER_DIAGNOSTICS[key], entry, `${file}: ${key} must use the owned entry`);
      assert.ok(Object.isFrozen(entry), key);
    }
  }
  assert.deepEqual([...owners.keys()].sort(), Object.keys(ORDER_DIAGNOSTICS).sort());
});

test('registry source files stay within the 400-line gate and owner modules document responsibility', () => {
  for (const name of ['order-rules', 'order-diagnostics']) {
    const directory = path.join(lib, name);
    for (const file of [`${name}.mjs`, ...moduleFiles(directory).map((file) => path.join(name, file))]) {
      const source = fs.readFileSync(path.join(lib, file), 'utf8');
      assert.ok(source.trimEnd().split(/\r?\n/).length <= 400, file);
      assert.match(source, /^\/\*\*[^]*?\*\//, `${file} must document responsibility`);
    }
  }
});

test('the real rule entry point refuses a synthetic duplicate across place modules', async (t) => {
  const { installedLib, entryPoint } = copyRegistry(t, 'order-rules');
  const bodyFile = path.join(installedLib, 'order-rules', 'task-document.mjs');
  const source = fs.readFileSync(bodyFile, 'utf8');
  const duplicate = source.replace('export const RULES = Object.freeze({',
    "import { RULES as HEADER_RULES } from './header.mjs';\n" +
    "export const RULES = Object.freeze({\n  'effort-value': HEADER_RULES['effort-value'],");
  assert.notEqual(duplicate, source, 'the fixture must introduce a duplicate');
  fs.writeFileSync(bodyFile, duplicate);
  await assert.rejects(import(pathToFileURL(entryPoint).href), {
    message: 'duplicate order rule key: effort-value',
  });
});

test('the real diagnostic entry point refuses a synthetic duplicate across category modules', async (t) => {
  const { installedLib, entryPoint } = copyRegistry(t, 'order-diagnostics');
  fs.writeFileSync(path.join(installedLib, 'order-diagnostics', 'filesystem.mjs'),
    "export const DIAGNOSTICS = Object.freeze({\n" +
    "  'no-wait-grant-conflict': Object.freeze({ category: 'filesystem', message: () => 'duplicate' }),\n" +
    '});\n');
  const source = fs.readFileSync(entryPoint, 'utf8');
  const duplicate = source.replace('const categories = [',
    "import { DIAGNOSTICS as FILESYSTEM_DIAGNOSTICS } from './order-diagnostics/filesystem.mjs';\n" +
    'const categories = [FILESYSTEM_DIAGNOSTICS, ');
  assert.notEqual(duplicate, source, 'the fixture must wire in the duplicate category');
  fs.writeFileSync(entryPoint, duplicate);
  await assert.rejects(import(pathToFileURL(entryPoint).href), {
    message: 'duplicate order diagnostic key: no-wait-grant-conflict',
  });
});

test('codex-bridge guidance order prints all six keys from a copied real registry and its place modules', (t) => {
  const { home, installedLib } = copyRegistry(t, 'order-rules');
  fs.copyFileSync(path.join(lib, 'shell-unsafe.mjs'), path.join(installedLib, 'shell-unsafe.mjs'));
  fs.mkdirSync(path.join(home, 'guidance'));
  fs.copyFileSync(new URL('../src/home/guidance/order.md', import.meta.url),
    path.join(home, 'guidance', 'order.md'));
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('../bin/codex-bridge.mjs', import.meta.url)), 'guidance', 'order',
  ], {
    cwd: home,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
    env: { ...process.env, CODEX_BRIDGE_HOME: home },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
  const renderedKeys = [...result.stdout.matchAll(/^- `([^`]+)`: /gm)].map((match) => match[1]);
  assert.deepEqual(renderedKeys, ruleKeys);
  for (const key of ruleKeys) assert.ok(result.stdout.includes(`- \`${key}\`: ${ORDER_RULES[key].rule}`), key);
  assert.doesNotMatch(result.stdout, /\{\{/);
});
