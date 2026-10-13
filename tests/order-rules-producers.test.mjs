/** Plan_79 B4g D3-D6: forwarded preflight text must already belong to the registry. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { advisorTaskRefusal, parseAdvisorTask } from '../src/home/lib/meta/advisor-task.mjs';
import { unavailableRows } from '../src/home/lib/meta/unavailable-rows.mjs';
import * as reply from '../src/home/lib/meta/reply.mjs';
import { retiredPathRefusal, staleOverrideRefusal } from '../src/home/lib/runner/runs-root.mjs';
import { readRunsMoveRecord, retiredRootRefusal } from '../src/home/lib/runner/retired-roots.mjs';
import { ORDER_RULES, orderRuleMessage } from '../src/home/lib/order-rules.mjs';
import { ORDER_DIAGNOSTICS, orderDiagnosticMessage } from '../src/home/lib/order-diagnostics.mjs';
import { checkOutgoingRefusal } from '../src/home/lib/order-text-record.mjs';
import { ADMISSION_FILES } from './order-guard/admission-files.mjs';
import { checkRefusalSites } from './order-guard/refusal-checker.mjs';
import { makeTempTree } from './temp-tree.mjs';

const options = '## Options\n- a: First\n- b: Second\n';
const validTask = options + '## Paths\n- src/file.mjs\n';
const advisorCases = [
  ['', 'Options: add a "## Options" section with at least two options.'],
  ['## Options\n', 'Options line 1 "## Options": provide at least two distinct options.'],
  ['## Options\n- a: First\n', 'Options line 1 "## Options": provide at least two distinct options.'],
  ['## Options\n- BAD: First\n',
    'Options line 2 "- BAD: First": use "- option-id: description" with id matching [a-z0-9][a-z0-9-]*.'],
  ['## Options\n- a: First\n- a: Second\n',
    'Options line 3 "- a: Second": replace duplicate option id "a".'],
  ['## Options\n- a: prefer First\n',
    'Options line 2 "- a: prefer First": remove preference marker "prefer" (D5).'],
  ['## Options\n★ First\n',
    'Options line 2 "★ First": remove preference marker "★" (D5).'],
  [options, 'Paths: add a "## Paths" section with repository-relative paths.'],
  [options + '## Paths\n',
    'Paths line 4 "## Paths": add at least one repository-relative path as a list item.'],
];

for (const [text, expected] of advisorCases) {
  test(`advisor producer preserves exact refusal: ${expected}`, () => {
    assert.equal(advisorTaskRefusal(text), expected);
    assert.equal(advisorTaskRefusal(text.replaceAll('\n', '\r\n')), expected);
    assert.equal(checkOutgoingRefusal(advisorTaskRefusal(text), 'producers-test'), expected);
  });
}

test('advisor success, parsing and non-string TypeError remain unchanged', () => {
  assert.equal(advisorTaskRefusal(validTask), null);
  assert.deepEqual(parseAdvisorTask(validTask), {
    options: [{ id: 'a', description: 'First' }, { id: 'b', description: 'Second' }],
    paths: ['src/file.mjs'],
  });
  for (const input of [undefined, null, 42, {}, new String(validTask)]) {
    for (const parse of [parseAdvisorTask, advisorTaskRefusal]) {
      assert.throws(() => parse(input), { name: 'TypeError', message: 'Advisor task text must be a string.' });
    }
  }
});

test('UNAVAILABLE rows retain exact handoff wording and signal formatting in their own module', () => {
  assert.equal(Object.hasOwn(reply, 'unavailableRows'), false);
  const rows = unavailableRows('  codex login\nstatus: Not logged in  ');
  assert.deepEqual(rows, [
    'UNAVAILABLE — Codex is not available (signed out); hand the task to the next executor, do not retry',
    'Signal: codex login status: Not logged in',
    'Operator check: codex --version; codex login status (sign in with codex login)',
  ]);
  assert.equal(unavailableRows()[1], 'Signal: ');
  assert.equal(unavailableRows('x'.repeat(180))[1], 'Signal: ' + 'x'.repeat(167) + '...');
  for (const row of rows) assert.equal(checkOutgoingRefusal(row, 'producers-test'), row);
});

test('retired producers retain exact messages, equivalent paths and null success values', () => {
  const root = path.resolve('old-runs');
  const destination = path.resolve('new-runs');
  for (const suffix of ['', 'Project/Run-ID']) {
    const candidate = suffix ? path.join(root, suffix) : root;
    const retired = { root, suffix };
    const equivalent = suffix ? path.join(destination, suffix) : destination;
    const expected = `Run records moved from ${root} to ${destination}. Equivalent path: ${equivalent}. ` +
      'Update advice: or pass this new path explicitly. No path was remapped.';
    const resolution = { root: candidate, homeRoot: destination, retired: [{ root }], staleOverride: retired };
    assert.equal(retiredRootRefusal({ candidate, retired, destination }), expected);
    assert.equal(retiredPathRefusal(candidate, resolution), expected);
    const stale = expected + '\n' +
      'CODEX_RUNS_ROOT points under a retired runs root; remove it or set it to the new location.';
    assert.equal(staleOverrideRefusal(resolution), stale);
    assert.equal(checkOutgoingRefusal(stale, 'producers-test'), stale);
    assert.equal(retiredPathRefusal(destination, resolution), null);
    assert.equal(staleOverrideRefusal({ ...resolution, staleOverride: null }), null);
  }
});

test('move record diagnostics preserve exact defect messages and Error types', (t) => {
  const stateDir = path.resolve('state');
  const file = path.join(stateDir, 'runs-root.json');
  const retired = { root: path.resolve('old-runs'), movedAt: '2026-10-08T12:30:00.000Z' };
  const cases = [
    [null, 'version must be 1'],
    [{ version: 2, retired: [retired] }, 'version must be 1'],
    [{ version: 1, retired: [] }, 'retired must be a non-empty array'],
    [{ version: 1, retired: [null] }, 'retired[0].root must be an absolute path'],
    [{ version: 1, retired: [retired, { ...retired, root: 'relative' }] },
      'retired[1].root must be an absolute path'],
    [{ version: 1, retired: [{ ...retired, movedAt: 'bad' }] },
      'retired[0].movedAt must be a parseable ISO time'],
  ];
  const read = t.mock.method(fs, 'readFileSync');
  for (const [record, detail] of cases) {
    read.mock.mockImplementation(() => JSON.stringify(record));
    assert.throws(() => readRunsMoveRecord(stateDir), (error) => {
      assert.equal(error.constructor, Error);
      assert.equal(error.message, `Invalid runs move record ${file}: ${detail}`);
      assert.equal(Object.hasOwn(error, 'cause'), false);
      assert.equal(checkOutgoingRefusal(error.message, 'producers-test'), error.message);
      return true;
    });
  }
  read.mock.restore();
});

test('move record read and parse errors preserve their causes and absence stays null', (t) => {
  const stateDir = path.resolve('state');
  const file = path.join(stateDir, 'runs-root.json');
  const cause = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  const read = t.mock.method(fs, 'readFileSync', () => { throw cause; });
  assert.throws(() => readRunsMoveRecord(stateDir), (error) => {
    assert.equal(error.constructor, Error);
    assert.equal(error.message, `Cannot read runs move record ${file}: permission denied`);
    assert.equal(error.cause, cause);
    return true;
  });
  read.mock.mockImplementation(() => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); });
  assert.equal(readRunsMoveRecord(stateDir), null);
  read.mock.mockImplementation(() => '{');
  assert.throws(() => readRunsMoveRecord(stateDir), (error) => {
    assert.equal(error.constructor, Error);
    assert.equal(error.message, `Invalid runs move record ${file}: ${error.cause.message}`);
    assert.ok(error.cause.cause instanceof SyntaxError);
    return true;
  });
  read.mock.restore();
});

for (const [builder, key, selector, message] of [
  [orderRuleMessage, 'advisor-task-options', 'violation', 'unknown advisor-task-options violation: unknown'],
  [orderRuleMessage, 'advisor-task-paths', 'violation', 'unknown advisor-task-paths violation: unknown'],
  [orderDiagnosticMessage, 'codex-unavailable-handoff', 'variant', 'unknown codex-unavailable-handoff variant: unknown'],
  [orderDiagnosticMessage, 'runs-move-record-invalid', 'violation', 'unknown runs-move-record-invalid violation: unknown'],
]) {
  test(`${key} refuses an unknown selector`, () => {
    assert.throws(() => builder(key, { [selector]: 'unknown' }), { name: 'Error', message });
  });
}

test('producer entries belong to their task/header places and diagnostic categories', () => {
  for (const key of ['advisor-task-options', 'advisor-task-paths', 'advice-retired-root']) {
    assert.equal(ORDER_RULES[key].topic, 'order');
    assert.ok(ORDER_RULES[key].rule.trim());
  }
  for (const key of ['codex-unavailable-handoff', 'stale-runs-root-override', 'runs-move-record-invalid']) {
    assert.equal(ORDER_DIAGNOSTICS[key].category, 'host-state');
  }
  assert.equal(ORDER_DIAGNOSTICS['runs-move-record-readable'].category, 'filesystem');
  assert.equal(ORDER_DIAGNOSTICS['advisor-task-text-required'].category, 'internal');
});

const producers = [
  'src/home/lib/meta/advisor-task.mjs',
  'src/home/lib/meta/unavailable-rows.mjs',
  'src/home/lib/runner/runs-root.mjs',
  'src/home/lib/runner/retired-roots.mjs',
];

for (const file of producers) {
  test(`${file} is admitted without recording, pending marks or opt-outs`, () => {
    const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.equal(ADMISSION_FILES.filter((entry) => entry === file).length, 1);
    assert.equal(ADMISSION_FILES.includes('src/home/lib/meta/reply.mjs'), false);
    assert.doesNotMatch(source, /recordOrderText|pending producer|pending-producer|pending[- ]migration/i);
    const result = checkRefusalSites(source, file);
    assert.deepEqual(result.violations, []);
    assert.deepEqual(result.optOuts, []);
  });
}

test('D6 producer probe journals handwritten text and unknown parameters in a separate child root', () => {
  const tree = makeTempTree('order-rules-producers-');
  const root = path.join(tree, 'marker');
  const lib = new URL('../src/home/lib/', import.meta.url);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { orderRuleMessage } from ${JSON.stringify(new URL('order-rules.mjs', lib).href)};
    import { orderDiagnosticMessage } from ${JSON.stringify(new URL('order-diagnostics.mjs', lib).href)};
    import { advisorTaskRefusal } from ${JSON.stringify(new URL('meta/advisor-task.mjs', lib).href)};
    import { unavailableRows } from ${JSON.stringify(new URL('meta/unavailable-rows.mjs', lib).href)};
    import { checkOutgoingRefusal } from ${JSON.stringify(new URL('order-text-record.mjs', lib).href)};
    checkOutgoingRefusal(advisorTaskRefusal(''), 'producers-probe');
    checkOutgoingRefusal(unavailableRows('signed out').join('\\n'), 'producers-probe');
    orderRuleMessage('question-context-marker', { context: 'task-input', refusal: 'handwritten refusal' });
    orderDiagnosticMessage('codex-unavailable-handoff', { variant: 'handoff', unknown: 'handwritten parameter' });
  `], { env: { ...process.env, CODEX_BRIDGE_TEST_TMP: root }, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const directory = path.join(root, 'order-text-violations');
  const entries = fs.readdirSync(directory).flatMap((file) =>
    fs.readFileSync(path.join(directory, file), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse));
  assert.deepEqual(entries.map(({ kind, key, parameter, message }) => [kind, key, parameter, message]), [
    ['parameter', 'question-context-marker', 'refusal', 'handwritten refusal'],
    ['parameter', 'codex-unavailable-handoff', 'unknown', 'handwritten parameter'],
  ]);
  for (const entry of entries) {
    assert.notEqual(entry.pid, process.pid);
    assert.match(entry.stack, /checkOrderTextParameters/);
    assert.ok(entry.caller);
  }
});
