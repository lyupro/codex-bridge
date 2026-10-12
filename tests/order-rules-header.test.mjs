/** Plan_79 B3c1: header rules preserve refusal bytes and D6 checks composed reasons before recording. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeTempTree } from './temp-tree.mjs';
import { ORDER_RULES, orderRuleMessage, orderRefusalAt, orderProblemLine } from '../src/home/lib/order-rules.mjs';
import { ORDER_DIAGNOSTICS, orderDiagnosticMessage } from '../src/home/lib/order-diagnostics.mjs';
import { parseTaskHeader, taskHeaderRefusal } from '../src/home/lib/task-header.mjs';
import { ADMISSION_FILES, PENDING_MIGRATION } from './order-guard/admission-files.mjs';
import { checkRefusalSites } from './order-guard/refusal-checker.mjs';

const messages = [
  ['order-header-label-shape', { label: 'scope', violation: 'empty' },
    'header label "scope" has an empty value'],
  ['order-header-label-shape', { label: 'order id', violation: 'spelling' },
    'write the header label exactly as "order id:"'],
  ['unknown-header-label', { label: 'budget', knownLabels: ['order id', 'scope', 'advice'] },
    'unknown header label "budget"; known labels: order id, scope, advice'],
  ['duplicate-order-label', { label: 'continue' }, 'duplicate continue label'],
  ['grant-label-exclusive', {}, 'continue and retry cannot both be present; keep exactly one grant label'],
  ['advice-value-shape', {}, 'advice value must be non-empty and single line'],
  ['grant-value-shape', {}, 'grant must name a bare run folder (not . or ..) and a non-placeholder reason'],
  ['header-metadata-placement', { label: 'continue', violation: 'misplaced' },
    'misplaced continue metadata; move it into the header at the top of the file, spelled continue: <value>; ' +
      'if it is an example, quote it with > or reword it inside a sentence'],
  ['header-metadata-placement', { label: 'retry', violation: 'misplaced' },
    'misplaced retry metadata; move it into the header at the top of the file, spelled retry: <value>; ' +
      'if it is an example, quote it with > or reword it inside a sentence'],
  ['header-metadata-placement', { label: 'advice', violation: 'misplaced' },
    'misplaced advice metadata; move it into the header at the top of the file, spelled advice: <value>; ' +
      'if it is an example, quote it with > or reword it inside a sentence'],
  ['header-metadata-placement', { label: 'advice', violation: 'empty' },
    'advice value must be non-empty and single line; ' +
      'move it into the header at the top of the file, spelled advice: <value>; ' +
      'if it is an example, quote it with > or reword it inside a sentence'],
  ['header-metadata-placement', { label: 'continue', violation: 'empty' },
    'continue value must be non-empty and single line; ' +
      'move it into the header at the top of the file, spelled continue: <value>; ' +
      'if it is an example, quote it with > or reword it inside a sentence'],
];

for (const [key, values, expected] of messages) {
  test(`${key} ${values.violation ?? values.label ?? 'value'} preserves the original message`, () => {
    assert.equal(orderRuleMessage(key, values), expected);
  });
}

test('header entries declare their data parameters and retain the order topic and author rule', () => {
  const data = {
    'order-header-label-shape': ['label', 'violation'],
    'unknown-header-label': ['label', 'knownLabels'],
    'duplicate-order-label': ['label'],
    'grant-label-exclusive': [],
    'advice-value-shape': [],
    'grant-value-shape': [],
    'header-metadata-placement': ['label', 'violation'],
  };
  for (const [key, parameters] of Object.entries(data)) {
    const entry = ORDER_RULES[key];
    assert.equal(entry.topic, 'order', key);
    assert.ok(entry.rule.trim(), key);
    assert.doesNotMatch(entry.rule, /\{\{/);
    assert.ok(Object.isFrozen(entry), key);
    assert.ok(Object.isFrozen(entry.data), key);
    assert.deepEqual(entry.data, parameters, key);
  }
});

test('header selectors refuse missing or unknown violations instead of picking a silent default', () => {
  for (const key of ['order-header-label-shape', 'header-metadata-placement']) {
    for (const violation of [undefined, 'unknown']) {
      assert.throws(() => orderRuleMessage(key, { label: 'scope', violation }), {
        message: `unknown ${key} violation: ${violation}`,
      });
    }
  }
});

test('label prefixes are composed from the registry validation reasons', () => {
  assert.equal(orderRefusalAt('advice', orderRuleMessage('advice-value-shape')),
    'advice: advice value must be non-empty and single line');
  for (const [label, expected] of [
    ['continue', 'continue: grant must name a bare run folder (not . or ..) and a non-placeholder reason'],
    ['retry', 'retry: grant must name a bare run folder (not . or ..) and a non-placeholder reason'],
  ]) {
    assert.equal(orderRefusalAt(label, orderRuleMessage('grant-value-shape')),
      expected);
  }
});

test('the composition builder preserves source lines, including colons, whitespace and Unicode', () => {
  assert.equal(orderProblemLine({ lineNo: 7, reason: orderRuleMessage('duplicate-order-label', { label: 'retry' }),
    line: '\tretry: Ω — why  ' }), 'line 7: duplicate retry label: \tretry: Ω — why  ');
  assert.ok(!Object.hasOwn(ORDER_RULES, 'order-problem-line'), 'composition owns no author rule');
});

test('the no-run, no-quota closing sentence belongs to the run-state diagnostic category', () => {
  const entry = ORDER_DIAGNOSTICS['run-not-created'];
  assert.equal(entry.category, 'run-state');
  assert.ok(Object.isFrozen(entry));
  assert.ok(Object.isFrozen(entry.data));
  assert.deepEqual(entry.data, []);
  assert.equal(orderDiagnosticMessage('run-not-created'), 'The run folder was not created; quota was not spent.');
});

test('parseTaskHeader retains exact problems, their order and the complete refusal', () => {
  const parsed = parseTaskHeader('continue: TODO\ncontinue: X — why\nbody\nadvice:');
  assert.deepEqual(parsed.problems, [
    { lineNo: 1, line: 'continue: TODO',
      reason: 'continue: grant must name a bare run folder (not . or ..) and a non-placeholder reason' },
    { lineNo: 2, line: 'continue: X — why', reason: 'duplicate continue label' },
    { lineNo: 4, line: 'advice:', reason: 'advice value must be non-empty and single line; ' +
      'move it into the header at the top of the file, spelled advice: <value>; ' +
      'if it is an example, quote it with > or reword it inside a sentence' },
  ]);
  assert.equal(taskHeaderRefusal(parsed),
    'line 1: continue: grant must name a bare run folder (not . or ..) and a non-placeholder reason: continue: TODO\n' +
    'line 2: duplicate continue label: continue: X — why\n' +
    'line 4: advice value must be non-empty and single line; ' +
    'move it into the header at the top of the file, spelled advice: <value>; ' +
    'if it is an example, quote it with > or reword it inside a sentence: advice:\n' +
    'The run folder was not created; quota was not spent.');
  assert.equal(parsed.grant, null);
  assert.equal(taskHeaderRefusal(parseTaskHeader('advice: mechanical\n\nbody')), null);
});

test('both header readers pass the static guard without migration exemptions or opt-outs', () => {
  for (const file of ['src/home/lib/task-header.mjs', 'src/home/lib/order-values.mjs']) {
    assert.ok(ADMISSION_FILES.includes(file), file);
    assert.ok(!PENDING_MIGRATION.has(file), file);
    const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.deepEqual(checkRefusalSites(source, file), { violations: [], optOuts: [] });
  }
});

test('a handwritten problem reason journals a D6 parameter violation in its own child marker', () => {
  // Plan_79 D6: deliberate violations must not enter npm test's own refusal journal.
  const root = path.join(makeTempTree('order-rules-header-'), 'marker');
  const rules = new URL('../src/home/lib/order-rules.mjs', import.meta.url).href;
  const recorder = new URL('../src/home/lib/order-text-record.mjs', import.meta.url).href;
  const header = new URL('../src/home/lib/task-header.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { orderProblemLine, orderRuleMessage } from ${JSON.stringify(rules)};
    import { checkOutgoingRefusal } from ${JSON.stringify(recorder)};
    import { parseTaskHeader, taskHeaderRefusal } from ${JSON.stringify(header)};
    const known = orderProblemLine({ lineNo: 2, line: 'arbitrary source data',
      reason: orderRuleMessage('duplicate-order-label', { label: 'retry' }) });
    checkOutgoingRefusal(known, 'header-probe');
    checkOutgoingRefusal(taskHeaderRefusal(parseTaskHeader('continue: TODO\\nadvice:')), 'header-probe');
    const output = orderProblemLine({ lineNo: 3, line: 'arbitrary source data', reason: 'hand-written header refusal' });
    assert.equal(output, 'line 3: hand-written header refusal: arbitrary source data');
    checkOutgoingRefusal(output, 'header-probe');
  `], { env: { ...process.env, CODEX_BRIDGE_TEST_TMP: root }, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const directory = path.join(root, 'order-text-violations');
  const entries = fs.readdirSync(directory).flatMap((file) =>
    fs.readFileSync(path.join(directory, file), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse));
  assert.equal(entries.length, 1, 'known registry text passes and recording cannot erase a parameter violation');
  const [entry] = entries;
  assert.equal(entry.kind, 'parameter');
  assert.equal(entry.builder, 'orderProblemLine');
  assert.equal(entry.key, null);
  assert.equal(entry.parameter, 'reason');
  assert.equal(entry.message, 'hand-written header refusal');
  assert.notEqual(entry.pid, process.pid);
  assert.match(entry.stack, /checkOrderTextParameters/);
  assert.ok(entry.caller);
});
