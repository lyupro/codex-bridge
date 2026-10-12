/** Plan_79 D6 prevents text parameters from laundering handwritten refusals into the registry. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { makeTempTree } from './temp-tree.mjs';
import { ORDER_RULES, validateOrderRules } from '../src/home/lib/order-rules.mjs';
import { ORDER_DIAGNOSTICS, validateOrderDiagnostics } from '../src/home/lib/order-diagnostics.mjs';

const lib = new URL('../src/home/lib/', import.meta.url);
const recorder = new URL('order-text-record.mjs', lib).href;
const rules = new URL('order-rules.mjs', lib).href;
const diagnostics = new URL('order-diagnostics.mjs', lib).href;
const inspector = new URL('../scripts/run-tests.mjs', import.meta.url).href;
const admission = new URL('./order-guard/admission-files.mjs', import.meta.url).href;

// Plan_79 D6: deliberate violations must never contaminate npm test's own journal.
function runCase(body, { marker = true, blocked = false } = {}) {
  const tree = makeTempTree('order-text-params-');
  const root = path.join(tree, 'marker');
  if (blocked) fs.writeFileSync(root, 'not a directory');
  const env = { ...process.env, D6_ROOT: root, D6_TREE: tree };
  if (marker) env.CODEX_BRIDGE_TEST_TMP = root;
  else delete env.CODEX_BRIDGE_TEST_TMP;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    import { pathToFileURL } from 'node:url';
    import { recordOrderText, checkOrderTextParameters, checkOutgoingRefusal } from ${JSON.stringify(recorder)};
    import { ORDER_RULES, orderRuleMessage, orderRefusalAt } from ${JSON.stringify(rules)};
    import { ORDER_DIAGNOSTICS, orderDiagnosticMessage } from ${JSON.stringify(diagnostics)};
    ${body}
  `], { env, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const directory = path.join(root, 'order-text-violations');
  const entries = fs.existsSync(directory) ? fs.readdirSync(directory).flatMap((file) =>
    fs.readFileSync(path.join(directory, file), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse)) : [];
  return { entries, result };
}

const laundering = [
  ['orderDiagnosticMessage', 'unknown-flag', 'help',
    "orderDiagnosticMessage('unknown-flag', { name: 'bad', help: 'any text' })",
    'unknown flag --bad: codex-bridge run takes only --agent, --task-file and --no-wait; ' +
      'the order belongs in the task-file header\nany text'],
  ['orderRefusalAt', null, 'message', "orderRefusalAt('task.md', 'any text')", 'task.md: any text'],
  ['orderRuleMessage', 'question-context-marker', 'refusal',
    "orderRuleMessage('question-context-marker', { context: 'task-input', refusal: 'any text' })",
    'any text; the marker is exactly [context-only] followed by a space and the question; no quota was spent.'],
  ['orderRuleMessage', 'repository-path', 'reason',
    "orderRuleMessage('repository-path', { context: 'task-input', label: 'repository', reason: 'any text' })",
    'repository any text\nThe run folder was not created; quota was not spent.'],
];

for (const [builder, key, parameter, expression, expected] of laundering) {
  test(`${builder} ${key ?? 'location'} rejects laundering through ${parameter} without changing output`, () => {
    const { entries } = runCase(`
      const outgoing = ${expression};
      assert.equal(outgoing, ${JSON.stringify(expected)});
      assert.equal(checkOutgoingRefusal(outgoing, 'case'), outgoing);
    `);
    assert.equal(entries.length, 1, 'recording the result cannot erase the earlier parameter violation');
    const entry = entries[0];
    assert.equal(entry.kind, 'parameter');
    assert.equal(entry.builder, builder);
    assert.equal(entry.key, key);
    assert.equal(entry.parameter, parameter);
    assert.equal(entry.message, 'any text');
    assert.notEqual(entry.pid, process.pid);
    assert.match(entry.stack, /checkOrderTextParameters/);
    assert.ok(entry.caller);
  });
}

test('recorded text, repetitions and the outgoing separator alphabet pass in all text slots', () => {
  const { entries } = runCase(`
    const known = orderDiagnosticMessage('agent-required');
    const other = orderRuleMessage('verify-line', { violation: 'empty' });
    const text = [known, other, known].join(${JSON.stringify(' \t:;,.\r\n')});
    const outputs = [
      orderDiagnosticMessage('unknown-flag', { name: 'bad', help: text }),
      orderRefusalAt('task.md', text),
      orderRuleMessage('question-context-marker', { context: 'task-input', refusal: text }),
      orderRuleMessage('repository-path', { context: 'task-input', label: 'repository', reason: text }),
    ];
    for (const output of outputs) assert.equal(checkOutgoingRefusal(output, 'case'), output);
  `);
  assert.deepEqual(entries, []);
});

test('empty, undefined and separator-only text parameters pass', () => {
  const { entries } = runCase(`
    for (const help of [undefined, '', ${JSON.stringify(' \t:;,.\r\n')}]) {
      assert.equal(orderDiagnosticMessage('unknown-flag', { name: 'bad', help }),
        ORDER_DIAGNOSTICS['unknown-flag'].message({ name: 'bad', help }));
    }
  `);
  assert.deepEqual(entries, []);
});

const expectedData = {
  'task-file-path': ['value'], 'task-body-required': ['channel', 'taskFile'],
  'effort-value': ['value'], 'run-slug': ['value'],
  'repository-path': ['violation', 'value', 'segment', 'context', 'label'],
  'scout-questions': ['violation', 'line'], 'question-context-marker': ['index', 'text', 'context'],
  'verify-line': ['violation'], 'no-wait-grant-conflict': ['grant'], 'task-channel-conflict': [],
  'unexpected-argument': ['value'], 'unknown-flag': ['name'], 'boolean-flag-value': ['name', 'value'],
  'missing-flag-value': ['key'], 'flag-shell-safety': ['name', 'sequence'], 'agent-required': [],
  'agent-known': ['agent'], 'task-file-readable': ['message'],
  'order-header-label-shape': ['label', 'violation'],
  'unknown-header-label': ['label', 'knownLabels'],
  'duplicate-order-label': ['label'],
  'grant-label-exclusive': [],
  'advice-value-shape': [],
  'grant-value-shape': [],
  'header-metadata-placement': ['label', 'violation'],
  'run-not-created': [],
  'agent-accepted-labels': ['label', 'agent'],
  'order-value-placeholder': ['label'],
  'header-shell-safety': ['labelName', 'sequence'],
  'build-existing-scope-required': ['labelName', 'newLabelName'],
  'required-order-labels': ['label', 'example'],
  'dispatcher-agent-known': ['agent'],
  'order-input-name-known': ['label'],
};

test('each entry freezes the caller-classified data allowlist and excludes forwarded prose', () => {
  for (const [key, entry] of Object.entries({ ...ORDER_RULES, ...ORDER_DIAGNOSTICS })) {
    assert.ok(Object.isFrozen(entry.data), key);
    assert.deepEqual(entry.data, expectedData[key], key);
  }
});

test('arbitrary prose, objects and numbers remain free in every declared data parameter', () => {
  const { entries } = runCase(`
    for (const [key, entry] of Object.entries({ ...ORDER_RULES, ...ORDER_DIAGNOSTICS })) {
      for (const parameter of entry.data) {
        for (const value of ['unregistered arbitrary prose!', 42, { data: 'prose' }]) {
          checkOrderTextParameters('data-fixture', key, { [parameter]: value }, entry.data);
        }
      }
    }
    assert.equal(orderDiagnosticMessage('unexpected-argument', { value: 'arbitrary prose!' }),
      'unexpected argument: arbitrary prose!');
    assert.equal(orderDiagnosticMessage('task-file-readable', { message: 'system error prose!' }),
      'task file from --task-file could not be read: system error prose!');
    assert.equal(orderRefusalAt('arbitrary location prose!', orderDiagnosticMessage('agent-required')),
      'arbitrary location prose!: --agent is required');
  `);
  assert.deepEqual(entries, []);
});

for (const [name, expression] of [
  ['number', '42'], ['boxed recorded string', "new String(recordOrderText('known'))"],
  ['object', "{ text: 'known' }"], ['null', 'null'], ['boolean', 'false'],
  ['circular object', '(() => { const value = {}; value.self = value; return value; })()'],
]) {
  test(`a ${name} in a text parameter fails without throwing or changing the result`, () => {
    const { entries } = runCase(`
      const help = ${expression};
      const values = { name: 'bad', help };
      assert.equal(orderDiagnosticMessage('unknown-flag', values), ORDER_DIAGNOSTICS['unknown-flag'].message(values));
    `);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, 'parameter');
    assert.equal(entries[0].parameter, 'help');
  });
}

test('text is checked before the entry message runs or its result is recorded', () => {
  const { entries } = runCase(`
    assert.throws(() => orderRuleMessage('repository-path', { violation: 'invalid', reason: 'unrecorded' }),
      { message: 'unknown repository-path violation: invalid' });
    orderDiagnosticMessage('agent-required', { unused: 'unrecorded' });
  `);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map(({ parameter }) => parameter), ['reason', 'unused']);
});

for (const name of ['order-rules', 'order-diagnostics']) {
  test(`a synthetic ${name} entry fails closed on an unlisted new parameter`, () => {
    const { entries } = runCase(`
      const installed = path.join(process.env.D6_TREE, 'installed');
      fs.mkdirSync(installed);
      fs.copyFileSync(${JSON.stringify(fileURLToPath(new URL(`${name}.mjs`, lib)))}, path.join(installed, '${name}.mjs'));
      fs.copyFileSync(${JSON.stringify(fileURLToPath(new URL('order-text-record.mjs', lib)))}, path.join(installed, 'order-text-record.mjs'));
      fs.cpSync(${JSON.stringify(fileURLToPath(new URL(`${name}/`, lib)))}, path.join(installed, '${name}'), { recursive: true });
      const owner = path.join(installed, '${name}', '${name === 'order-rules' ? 'call' : 'cli-flags'}.mjs');
      const source = fs.readFileSync(owner, 'utf8');
      const replacement = source.replace('Object.freeze({',
        "Object.freeze({ 'synthetic-entry': Object.freeze({ data: Object.freeze([]), message: ({ newText }) => newText }),");
      assert.notEqual(replacement, source);
      fs.writeFileSync(owner, replacement);
      const registry = await import(pathToFileURL(path.join(installed, '${name}.mjs')).href);
      assert.equal(registry.${name === 'order-rules' ? 'orderRuleMessage' : 'orderDiagnosticMessage'}('synthetic-entry', { newText: 'fresh prose' }), 'fresh prose');
    `);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].key, 'synthetic-entry');
    assert.equal(entries[0].parameter, 'newText');
    assert.equal(entries[0].kind, 'parameter');
  });
}

for (const [name, validate, entry] of [
  ['rule', (value) => validateOrderRules({ sample: value }, { order: {} }, {}), ORDER_RULES['verify-line']],
  ['diagnostic', (value) => validateOrderDiagnostics({ sample: value }), ORDER_DIAGNOSTICS['agent-required']],
]) {
  test(`${name} validator requires a unique array of non-empty primitive strings`, () => {
    assert.doesNotThrow(() => validate(entry));
    for (const data of [null, undefined, 'value', {}, [''], [' '], [1], ['x', 'x'], [new String('x')], Array(1)]) {
      assert.throws(() => validate({ ...entry, data }), /invalid order (?:rule|diagnostic) data: sample/);
    }
    const { data, ...missing } = entry;
    assert.throws(() => validate(missing), /invalid order (?:rule|diagnostic) entry: sample/);
  });
}

test('without test mode builders preserve text and neither check nor record or write', () => {
  const { entries } = runCase(`
    for (const expression of [
      () => orderDiagnosticMessage('unknown-flag', { name: 'bad', help: 'unrecorded' }),
      () => orderRefusalAt('location', 'unrecorded'),
      () => orderRuleMessage('question-context-marker', { context: 'task-input', refusal: 'unrecorded' }),
      () => orderRuleMessage('repository-path', { context: 'task-input', label: 'repository', reason: 'unrecorded' }),
    ]) assert.doesNotThrow(expression);
    recordOrderText('not recorded');
    assert.equal(fs.existsSync(process.env.D6_ROOT), false);
    process.env.CODEX_BRIDGE_TEST_TMP = process.env.D6_ROOT;
    orderRefusalAt('location', 'not recorded');
  `, { marker: false });
  assert.equal(entries.length, 1, 'recording outside test mode must have been a no-op');
  assert.equal(entries[0].kind, 'parameter');
});

test('an unwritable journal never throws or changes the builder result', () => {
  const { entries } = runCase(`
    assert.doesNotThrow(() => assert.equal(orderRefusalAt('location', 'unrecorded'), 'location: unrecorded'));
  `, { blocked: true });
  assert.deepEqual(entries, []);
});

test('parameter violations from a pending caller are fatal while its outgoing violations are tolerated', () => {
  runCase(`
    const { inspectOutgoingRefusals } = await import(${JSON.stringify(inspector)});
    const { PENDING_MIGRATION } = await import(${JSON.stringify(admission)});
    const { die, RunnerUsageError } = await import(${JSON.stringify(new URL('runner/args.mjs', lib).href)});
    const vm = await import('node:vm');
    const pending = [...PENDING_MIGRATION][0];
    const directory = path.join(process.env.D6_ROOT, 'order-text-violations');
    const pendingCaller = vm.runInThisContext(
      '(build, die) => { build("location", "unrecorded parameter"); die("unrecorded outgoing"); }',
      { filename: 'file:///C:/fixture/' + pending });
    assert.throws(() => pendingCaller(orderRefusalAt, die), RunnerUsageError);
    const output = [];
    assert.equal(inspectOutgoingRefusals(directory, PENDING_MIGRATION, (line) => output.push(line)), 1);
    assert.equal(output.length, 2);
    assert.match(output[0], /"kind":"parameter"/);
    assert.equal(output[1], ${JSON.stringify('run-tests: 1 refusals from pending files tolerated until their migration\n')});
  `);
});

const producerComment = '// Plan_79 D5: pending producer, recorded until its file migrates';
const exempt = new Set(['lib/order-text-record.mjs', 'lib/order-rules.mjs', 'lib/order-diagnostics.mjs']);

function unmarkedRecords(source) {
  const lines = source.split(/\r?\n/);
  return lines.flatMap((line, index) => line.includes('recordOrderText(') &&
    lines[index - 1]?.trim() !== producerComment ? [index + 1] : []);
}

test('home producers record only directly beneath the explicit pending-migration comment', () => {
  const home = fileURLToPath(new URL('../src/home/', import.meta.url));
  const violations = [];
  for (const file of fs.readdirSync(home, { recursive: true }).filter((file) => file.endsWith('.mjs'))) {
    if (exempt.has(file.replaceAll('\\', '/'))) continue;
    for (const line of unmarkedRecords(fs.readFileSync(path.join(home, file), 'utf8'))) {
      violations.push(`${file}:${line}`);
    }
  }
  assert.deepEqual(violations, []);
});

test('the producer guard rejects an unmarked fixture and a non-adjacent marker', () => {
  assert.deepEqual(unmarkedRecords("return recordOrderText('handwritten');"), [1]);
  assert.deepEqual(unmarkedRecords(producerComment + "\nreturn recordOrderText('pending');"), []);
  assert.deepEqual(unmarkedRecords(producerComment + "\n\nreturn recordOrderText('handwritten');"), [3]);
});
