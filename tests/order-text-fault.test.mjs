/** Plan_79 D9: a journal failure cannot disappear behind a hook's exception or exit(0). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeTempTree } from './temp-tree.mjs';
import { ORDER_TEXT_FAULT_EXIT, orderTextFaultDirectory } from '../src/home/lib/order-text-record.mjs';
import { inspectOrderTextFaults } from '../scripts/run-tests.mjs';

const recorder = new URL('../src/home/lib/order-text-record.mjs', import.meta.url);
const prefix = 'order-text-record: journal write failed: ';

// Plan_79 D9: negative fixtures redirect the root so their markers cannot poison the outer suite.
function runCase(body, { blocked = false, marker = true, status = 0 } = {}) {
  const tree = makeTempTree('order-text-fault-');
  const root = path.join(tree, 'marker');
  if (blocked) fs.writeFileSync(root, 'not a directory');
  const env = { ...process.env, D9_ROOT: root };
  if (marker) env.CODEX_BRIDGE_TEST_TMP = root;
  else delete env.CODEX_BRIDGE_TEST_TMP;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    import { recordOrderText, checkOrderTextParameters, checkOutgoingRefusal,
      orderTextFaultDirectory, ORDER_TEXT_FAULT_EXIT } from ${JSON.stringify(recorder.href)};
    ${body}
  `], { env, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  assert.ifError(result.error);
  assert.equal(result.status, status, result.stderr || result.stdout);
  const journal = path.join(root, 'order-text-violations');
  const lines = fs.existsSync(journal) ? fs.readdirSync(journal).flatMap((file) =>
    fs.readFileSync(path.join(journal, file), 'utf8').split(/\r?\n/).filter(Boolean)) : [];
  return { root, result, lines, entries: lines.map(JSON.parse) };
}

function faultEntries(root, result) {
  const directory = orderTextFaultDirectory(root);
  assert.equal(path.dirname(directory), path.dirname(root));
  assert.deepEqual(fs.readdirSync(directory), [`${result.pid}.jsonl`]);
  const lines = fs.readFileSync(path.join(directory, `${result.pid}.jsonl`), 'utf8')
    .split(/\r?\n/).filter(Boolean);
  assert.equal(result.stderr, lines.map((line) => `${prefix}${line}\n`).join(''));
  assert.equal(fs.existsSync(orderTextFaultDirectory(process.env.CODEX_BRIDGE_TEST_TMP)), false);
  return lines.map(JSON.parse);
}

test('a blocked journal reports every offending parameter before stopping', () => {
  const { root, result, entries } = runCase(`
    checkOrderTextParameters('batch-builder', 'batch-key',
      { first: 'first handwritten', second: 'second handwritten' }, []);
  `, { blocked: true, status: ORDER_TEXT_FAULT_EXIT });
  assert.deepEqual(entries, []);
  assert.equal(result.stdout, '');
  const faults = faultEntries(root, result);
  assert.deepEqual(faults.map(({ parameter, message }) => [parameter, message]), [
    ['first', 'first handwritten'], ['second', 'second handwritten'],
  ]);
  for (const entry of faults) {
    assert.equal(entry.kind, 'parameter');
    assert.equal(entry.builder, 'batch-builder');
    assert.equal(entry.key, 'batch-key');
    assert.equal(entry.valueType, 'string');
    assert.equal(entry.pid, result.pid);
    assert.match(entry.error, /EEXIST|ENOTDIR/);
    assert.match(entry.stack, /checkOrderTextParameters/);
  }
});

test('a hook-shaped child cannot swallow a journal fault or override it with exit(0)', () => {
  const { root, result, entries } = runCase(`
    try { checkOutgoingRefusal('handwritten hook refusal', 'deny'); } catch {}
    process.stdout.write('hook output');
    process.exit(0);
  `, { blocked: true, status: ORDER_TEXT_FAULT_EXIT });
  assert.equal(result.stdout, '');
  assert.deepEqual(entries, []);
  const [entry] = faultEntries(root, result);
  assert.equal(entry.kind, 'outgoing');
  assert.equal(entry.transport, 'deny');
  assert.equal(entry.message, 'handwritten hook refusal');
});

// Plan_79 D9: the one catch must hand its error to journalFault; an assert.throws validator was a
// catch under another name (B11 acceptance), so the assertion library stays out of the module.
test('the only catch in the recorder hands every write failure to the fault exit', () => {
  const source = fs.readFileSync(recorder, 'utf8');
  const guard = (text) => {
    assert.equal(text.match(/\bcatch\s*[({]/g)?.length, 1);
    assert.match(text, /\} catch \(error\) \{\s*journalFault\(root, journal, error\);\s*\}/);
    assert.doesNotMatch(text, /node:assert/);
  };
  guard(source);
  const swallowing = source.replace(/journalFault\(root, journal, error\);/, '');
  for (const mutation of [source + '\ntry {} catch {}\n', source + '\ntry {} catch (error) {}\n', swallowing,
    `import assert from 'node:assert/strict';\n${source}`]) {
    assert.throws(() => guard(mutation), assert.AssertionError);
  }
});

test('a healthy journal appends two parameter lines once and preserves status, output and caller', () => {
  const { root, result, entries } = runCase(`
    const originalAppend = fs.appendFileSync;
    let appends = 0;
    fs.appendFileSync = (...args) => { appends++; return originalAppend(...args); };
    Error.stackTraceLimit = 1;
    const values = { first: 'first handwritten', second: 'second handwritten' };
    function builder(input) { return checkOrderTextParameters('batch-builder', 'batch-key', input, []); }
    function builderCaller() { return builder(values); }
    assert.equal(builderCaller(), values);
    assert.equal(appends, 1);
    assert.equal(Error.stackTraceLimit, 1);
    process.stdout.write('unchanged stdout\\n');
    process.stderr.write('unchanged stderr\\n');
  `);
  assert.equal(result.stdout, 'unchanged stdout\n');
  assert.equal(result.stderr, 'unchanged stderr\n');
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map(({ parameter }) => parameter), ['first', 'second']);
  for (const entry of entries) {
    assert.equal(entry.kind, 'parameter');
    assert.equal(entry.builder, 'batch-builder');
    assert.equal(entry.key, 'batch-key');
    assert.equal(entry.valueType, 'string');
    assert.equal(entry.pid, result.pid);
    assert.match(entry.caller, /^at builderCaller /);
    assert.equal(entry.caller, entry.stack.split('\n')[2].trim());
    assert.equal(Object.hasOwn(entry, 'error'), false);
  }
  assert.equal(fs.existsSync(orderTextFaultDirectory(root)), false);
});

test('an append failure reports the complete batch and exits before the caller continues', () => {
  const { root, result, entries } = runCase(`
    const originalAppend = fs.appendFileSync;
    fs.appendFileSync = (file, ...args) => {
      if (path.dirname(file) === path.join(process.env.D9_ROOT, 'order-text-violations')) {
        throw new Error('EPERM: deliberate journal append failure');
      }
      return originalAppend(file, ...args);
    };
    checkOrderTextParameters('batch-builder', null, { first: 'first', second: 'second' }, []);
    process.stdout.write('unreachable');
  `, { status: ORDER_TEXT_FAULT_EXIT });
  assert.equal(result.stdout, '');
  assert.deepEqual(entries, []);
  const faults = faultEntries(root, result);
  assert.deepEqual(faults.map(({ parameter }) => parameter), ['first', 'second']);
  assert.ok(faults.every(({ error }) => error === 'EPERM: deliberate journal append failure'));
});

test('a marker write failure cannot prevent the dedicated fault exit', () => {
  const { root, result, entries } = runCase(`
    fs.appendFileSync = () => { throw new Error('EPERM: deliberate marker failure'); };
    try { checkOutgoingRefusal('handwritten', 'deny'); } catch {}
    process.stdout.write('unreachable');
    process.exit(0);
  `, { blocked: true, status: ORDER_TEXT_FAULT_EXIT });
  assert.equal(result.stdout, '');
  assert.deepEqual(entries, []);
  assert.match(result.stderr, /^order-text-record: journal write failed: /);
  assert.equal(fs.existsSync(orderTextFaultDirectory(root)), true);
  assert.deepEqual(fs.readdirSync(orderTextFaultDirectory(root)), []);
});

test('a fault-directory creation failure cannot prevent the dedicated fault exit', () => {
  const { root, result } = runCase(`
    fs.writeFileSync(orderTextFaultDirectory(process.env.D9_ROOT), 'not a directory');
    try { checkOutgoingRefusal('handwritten', 'deny'); } catch {}
    process.stdout.write('unreachable');
    process.exit(0);
  `, { blocked: true, status: ORDER_TEXT_FAULT_EXIT });
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^order-text-record: journal write failed: /);
  assert.equal(fs.readFileSync(orderTextFaultDirectory(root), 'utf8'), 'not a directory');
});

test('a synchronous stderr failure cannot prevent the dedicated fault exit', () => {
  const { result } = runCase(`
    fs.writeSync = () => { throw new Error('stderr is unavailable'); };
    try { checkOutgoingRefusal('handwritten', 'deny'); } catch {}
    process.stdout.write('unreachable');
    process.exit(0);
  `, { blocked: true, status: ORDER_TEXT_FAULT_EXIT });
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('non-string outgoing messages journal valueType without coercion and return the original value', () => {
  const { root, result, entries } = runCase(`
    const circular = {}; circular.self = circular;
    const hostile = { toString() { throw new Error('must not coerce'); } };
    const messages = [undefined, null, 42, false, 1n, Symbol('message'),
      new String('boxed'), circular, hostile, () => {}];
    for (const message of messages) assert.equal(checkOutgoingRefusal(message, 'typed'), message);
  `);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.deepEqual(entries.map(({ valueType }) => valueType), [
    'undefined', 'object', 'number', 'boolean', 'bigint', 'symbol', 'object', 'object', 'object', 'function',
  ]);
  for (const entry of entries) {
    assert.equal(entry.kind, 'outgoing');
    assert.equal(entry.transport, 'typed');
    assert.equal(Object.hasOwn(entry, 'message'), false);
  }
  assert.equal(fs.existsSync(orderTextFaultDirectory(root)), false);
});

test('clean checks and checks outside test mode touch no filesystem sinks', () => {
  for (const marker of [true, false]) {
    const { root, result, entries } = runCase(`
      fs.mkdirSync = fs.appendFileSync = fs.writeSync = () => { throw new Error('unexpected write'); };
      const known = recordOrderText('registered');
      const values = { help: known, empty: '', missing: undefined, data: 'arbitrary' };
      assert.equal(checkOrderTextParameters('clean', null, values, ['data']), values);
      assert.equal(checkOutgoingRefusal(known, 'clean'), known);
      if (!process.env.CODEX_BRIDGE_TEST_TMP) {
        assert.equal(checkOutgoingRefusal(null, 'disabled'), null);
        assert.equal(checkOrderTextParameters('disabled', null, { help: {} }, []).help.constructor, Object);
      }
    `, { marker });
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
    assert.deepEqual(entries, []);
    assert.equal(fs.existsSync(root), false);
    assert.equal(fs.existsSync(orderTextFaultDirectory(root)), false);
  }
});

test('the runner counts and reports every fault-marker line as fatal', () => {
  const tree = makeTempTree('order-text-fault-inspection-');
  const directory = orderTextFaultDirectory(path.join(tree, 'root'));
  fs.mkdirSync(directory);
  const lines = [
    JSON.stringify({ kind: 'parameter', parameter: 'first', message: 'first', error: 'EPERM' }),
    JSON.stringify({ kind: 'parameter', parameter: 'second', message: 'second', error: 'EPERM' }),
  ];
  fs.writeFileSync(path.join(directory, '1.jsonl'), lines.join('\n') + '\n');
  const output = [];
  assert.equal(inspectOrderTextFaults(directory, (line) => output.push(line)), 2);
  assert.deepEqual(output, lines.map((line) => `run-tests: refusal check could not journal: ${line}\n`));
});

test('any marker file is fatal, including an empty or malformed one', () => {
  const tree = makeTempTree('order-text-fault-empty-');
  const directory = orderTextFaultDirectory(path.join(tree, 'root'));
  assert.equal(inspectOrderTextFaults(directory, () => assert.fail('absent directory reported')), 0);
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'empty.jsonl'), '');
  fs.writeFileSync(path.join(directory, 'malformed.jsonl'), '{"error":\n');
  const output = [];
  assert.equal(inspectOrderTextFaults(directory, (line) => output.push(line)), 2);
  assert.deepEqual(output, [
    'run-tests: refusal check could not journal: empty fault marker: empty.jsonl\n',
    'run-tests: refusal check could not journal: {"error":\n',
  ]);
});
