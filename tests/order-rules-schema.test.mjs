/** Plan_79 B3c2: schema refusals retain their bytes while D6 separates label data from issued text. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeTempTree } from './temp-tree.mjs';
import { ORDER_RULES, orderRuleMessage, orderProblemLine, orderHeaderHelp } from '../src/home/lib/order-rules.mjs';
import { ORDER_DIAGNOSTICS, orderDiagnosticMessage } from '../src/home/lib/order-diagnostics.mjs';
import {
  ORDER_AGENTS, ALL_ORDER_LABELS, orderLabelsFor, orderInputName, orderFromHeader,
  renderOrderProblems, renderOrderHeaderHelp,
} from '../src/home/lib/order-schema.mjs';
import { parseTaskHeader } from '../src/home/lib/task-header.mjs';
import { ADMISSION_FILES } from './order-guard/admission-files.mjs';
import { checkRefusalSites } from './order-guard/refusal-checker.mjs';

// Plan_79 B3c2: literal expectations copy the original schema sites, not the registry messages.
const messages = [
  ['agent-accepted-labels', { label: 'scope new', agent: 'codex-scout' },
    'label "scope new" is not accepted by codex-scout'],
  ['order-value-placeholder', { label: 'order id' }, 'label "order id" is still a placeholder'],
  ['header-shell-safety', { labelName: '`slug:`', sequence: ';' },
    '`slug:` contains forbidden shell sequence ";"; put free text in the task file body and keep header values short'],
  ['header-shell-safety', { labelName: '`scope:`', sequence: '`' },
    '`scope:` contains forbidden shell sequence "`"; put free text in the task file body and keep header values short'],
  ['header-shell-safety', { labelName: '`scope:`', sequence: '$(' },
    '`scope:` contains forbidden shell sequence "$("; put free text in the task file body and keep header values short'],
  ['build-existing-scope-required', { labelName: '`scope:`', newLabelName: '`scope new:`' },
    '`scope:` is required for codex-build: declare at least one existing path pattern; `scope new:` does not replace it.'],
  ['required-order-labels', { label: 'scope', example: 'src/home/lib/runner/**,tests/runner/**' },
    'missing required header label "scope:"; example: scope: src/home/lib/runner/**,tests/runner/**'],
  ['required-order-labels', { label: 'phase', example: 'scope' },
    'missing required header label "phase:"; example: phase: scope'],
];

for (const [key, values, expected] of messages) {
  test(`${key} preserves the schema message for ${JSON.stringify(values)}`, () => {
    assert.equal(orderRuleMessage(key, values), expected);
    assert.equal(ORDER_RULES[key].message(values), expected);
    assert.equal(ORDER_RULES[key].topic, 'order');
    assert.ok(ORDER_RULES[key].rule.trim());
  });
}

for (const [key, values, expected] of [
  ['dispatcher-agent-known', { agent: 'unknown' }, 'unknown dispatcher agent "unknown"'],
  ['dispatcher-agent-known', { agent: '__proto__' }, 'unknown dispatcher agent "__proto__"'],
  ['order-input-name-known', { label: 'unknown input' }, 'Unknown order input label "unknown input"'],
  ['order-input-name-known', { label: 'constructor' }, 'Unknown order input label "constructor"'],
]) {
  test(`${key} preserves its internal diagnostic for ${JSON.stringify(values)}`, () => {
    assert.equal(orderDiagnosticMessage(key, values), expected);
    assert.equal(ORDER_DIAGNOSTICS[key].message(values), expected);
    assert.equal(ORDER_DIAGNOSTICS[key].category, 'internal');
    if (key === 'order-input-name-known') {
      assert.throws(() => orderInputName(values.label), { name: 'Error', message: expected });
    } else {
      assert.deepEqual(orderFromHeader(values.agent, parseTaskHeader('order id: schema-pass')), {
        order: new Map(), problems: [{ lineNo: null, line: '', reason: expected }],
      });
    }
  });
}

test('schema rules describe the author constraints and classify formatted names as data', () => {
  assert.match(ORDER_RULES['agent-accepted-labels'].rule, /header labels accepted by the agent/);
  assert.match(ORDER_RULES['order-value-placeholder'].rule, /placeholder header values/);
  assert.match(ORDER_RULES['header-shell-safety'].rule, /forbidden shell sequences/);
  assert.match(ORDER_RULES['build-existing-scope-required'].rule, /at least one existing path pattern/);
  assert.match(ORDER_RULES['build-existing-scope-required'].rule, /scope new does not replace it/);
  assert.match(ORDER_RULES['required-order-labels'].rule, /every required header label/);
  for (const label of ALL_ORDER_LABELS) assert.equal(orderInputName(label), `\`${label}:\``);
  const source = fs.readFileSync(new URL('../src/home/lib/order-rules/header.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bimport\b[^;]*order-schema\.mjs/);
});

test('schema migration preserves problem order, physical lines and the accepted order', () => {
  const parsed = parseTaskHeader('order id: TODO\nscope: , ,\nslug: bad;value');
  assert.deepEqual(orderFromHeader('codex-build', parsed), {
    order: new Map([['order id', 'TODO'], ['scope', ', ,'], ['slug', 'bad;value']]),
    problems: [
      { lineNo: 1, line: 'order id: TODO', reason: 'label "order id" is still a placeholder' },
      { lineNo: 2, line: 'scope: , ,',
        reason: '`scope:` is required for codex-build: declare at least one existing path pattern; ' +
          '`scope new:` does not replace it.' },
      { lineNo: 3, line: 'slug: bad;value',
        reason: '`slug:` contains forbidden shell sequence ";"; ' +
          'put free text in the task file body and keep header values short' },
    ],
  });
});

test('scope new alone does not replace a missing required existing-file scope', () => {
  const parsed = parseTaskHeader('order id: schema-pass\nscope new: src/new.mjs');
  assert.deepEqual(orderFromHeader('codex-build', parsed).problems, [{ lineNo: null, line: '',
    reason: 'missing required header label "scope:"; example: scope: src/home/lib/runner/**,tests/runner/**' }]);
});

test('the help builder renders schema data without owning a rule or adding a default', () => {
  assert.equal(orderHeaderHelp([
    { label: 'scope', example: 'src/**,tests/**' },
    { label: 'scope new', example: 'new/Ω file.mjs' },
  ]), 'scope: src/**,tests/**\nscope new: new/Ω file.mjs');
  assert.equal(orderHeaderHelp([]), '');
  assert.throws(() => orderHeaderHelp(), TypeError);
  assert.ok(!Object.hasOwn(ORDER_RULES, 'write-order-header-help'));
});

const scoutHelp = 'order id: plan-13-scout-20260804\n' +
  'continue: 2026-08-05_092913_plan14-build — LIMIT at step 3, tests unwritten\n' +
  'retry: 2026-10-03_172017_cc-d66-advisor — model at capacity, same pass again\n' +
  'resume: 2026-10-16_140740_ow066-b2-resume-grant — advise stalled after reading, continue its thread\n' +
  'repository: C:/work/codex-bridge\nslug: plan-76-parser\neffort: high';
const buildHelp = 'order id: plan-13-build-20260804\nscope: src/home/lib/runner/**,tests/runner/**\n' +
  'continue: 2026-08-05_092913_plan14-build — LIMIT at step 3, tests unwritten\n' +
  'retry: 2026-10-03_172017_cc-d66-advisor — model at capacity, same pass again\n' +
  'repository: C:/work/codex-bridge\nscope new: src/home/lib/dispatcher-call.mjs,tests/dispatcher-call.test.mjs\n' +
  'slug: plan-76-parser\neffort: high';
const reviewHelp = 'order id: plan-13-review-20260804\n' +
  'continue: 2026-08-05_092913_plan14-build — LIMIT at step 3, tests unwritten\n' +
  'retry: 2026-10-03_172017_cc-d66-advisor — model at capacity, same pass again\n' +
  'resume: 2026-10-16_140740_ow066-b2-resume-grant — advise stalled after reading, continue its thread\n' +
  'repository: C:/work/codex-bridge\nslug: plan-76-parser\neffort: high\nchangeset: base:main';
const advisorHelp = 'order id: plan-59-advisor-20260922\nphase: scope\n' +
  'continue: 2026-08-05_092913_plan14-build — LIMIT at step 3, tests unwritten\n' +
  'retry: 2026-10-03_172017_cc-d66-advisor — model at capacity, same pass again\n' +
  'resume: 2026-10-16_140740_ow066-b2-resume-grant — advise stalled after reading, continue its thread\n' +
  'repository: C:/work/codex-bridge\nslug: plan-76-parser\neffort: high';

for (const [agent, expected] of [
  ['codex-scout', scoutHelp], ['codex-build', buildHelp],
  ['codex-review', reviewHelp], ['codex-advisor', advisorHelp], ['unknown', ''],
]) {
  test(`${agent} header help preserves literal bytes and required, conditional, optional order`, () => {
    assert.equal(renderOrderHeaderHelp(agent), expected);
    const labels = orderLabelsFor(agent);
    const ordered = ['required', 'conditional', 'optional'].flatMap((category) =>
      labels.filter((entry) => entry[category]));
    assert.equal(orderHeaderHelp(ordered), expected);
  });
}

test('problem composition omits absent locations and appends help with the original separator', () => {
  const reason = orderRuleMessage('order-value-placeholder', { label: 'scope' });
  assert.equal(orderProblemLine({ lineNo: null, line: 'ignored', reason }), 'label "scope" is still a placeholder');
  const missing = orderRuleMessage('required-order-labels', { label: 'order id', example: 'plan-13-build-20260804' });
  assert.equal(renderOrderProblems('codex-build', [
    { lineNo: 1, line: 'scope: TODO', reason }, { lineNo: null, line: '', reason: missing },
  ]), 'line 1: label "scope" is still a placeholder: scope: TODO\n' +
    'missing required header label "order id:"; example: order id: plan-13-build-20260804\n' + buildHelp);
  assert.equal(renderOrderProblems('unknown', [{ lineNo: null, line: '',
    reason: orderDiagnosticMessage('dispatcher-agent-known', { agent: 'unknown' }) }]),
  'unknown dispatcher agent "unknown"\n');
  assert.equal(renderOrderProblems('codex-scout', []), scoutHelp);
  assert.equal(renderOrderProblems('unknown', []), '');
});

test('order-schema passes the static guard without pending migration or opt-outs', () => {
  const file = 'src/home/lib/order-schema.mjs';
  assert.ok(ADMISSION_FILES.includes(file));
  const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  assert.deepEqual(checkRefusalSites(source, file), { violations: [], optOuts: [] });
  assert.doesNotMatch(source, /recordOrderText|pending producer/);
});

test('home has no recordOrderText calls outside the registry entry points', () => {
  const home = new URL('../src/home/', import.meta.url);
  const exempt = new Set(['lib/order-text-record.mjs', 'lib/order-rules.mjs', 'lib/order-diagnostics.mjs']);
  for (const file of fs.readdirSync(home, { recursive: true }).filter((file) => file.endsWith('.mjs'))) {
    if (exempt.has(file.replaceAll('\\', '/'))) continue;
    assert.doesNotMatch(fs.readFileSync(new URL(file.replaceAll('\\', '/'), home), 'utf8'),
      /\brecordOrderText\s*\(/, file);
  }
});

// Plan_79 D6: child marker roots isolate deliberate parameter violations from npm test's journal.
function runProbe(body) {
  const root = path.join(makeTempTree('order-rules-schema-'), 'marker');
  const rules = new URL('../src/home/lib/order-rules.mjs', import.meta.url).href;
  const recorder = new URL('../src/home/lib/order-text-record.mjs', import.meta.url).href;
  const schema = new URL('../src/home/lib/order-schema.mjs', import.meta.url).href;
  const header = new URL('../src/home/lib/task-header.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { orderRuleMessage } from ${JSON.stringify(rules)};
    import { checkOrderTextParameters, checkOutgoingRefusal } from ${JSON.stringify(recorder)};
    import { orderInputName, orderFromHeader, renderOrderProblems, renderOrderHeaderHelp } from ${JSON.stringify(schema)};
    import { parseTaskHeader } from ${JSON.stringify(header)};
    ${body}
  `], { env: { ...process.env, CODEX_BRIDGE_TEST_TMP: root }, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const directory = path.join(root, 'order-text-violations');
  return fs.readdirSync(directory).flatMap((file) =>
    fs.readFileSync(path.join(directory, file), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse));
}

test('a handwritten rule text parameter journals a violation after valid schema refusals and help', () => {
  const entries = runProbe(`
    for (const agent of ${JSON.stringify(ORDER_AGENTS)}) {
      const { problems } = orderFromHeader(agent, parseTaskHeader('order id: TODO\\nscope: , ,\\nslug: bad;value'));
      checkOutgoingRefusal(renderOrderProblems(agent, problems), 'schema-probe');
      checkOutgoingRefusal(renderOrderHeaderHelp(agent), 'schema-probe');
    }
    const output = orderRuleMessage('repository-path', {
      context: 'task-input', label: orderInputName('repository'), reason: 'hand-written schema refusal',
    });
    assert.equal(output, '\`repository:\` hand-written schema refusal\\nThe run folder was not created; quota was not spent.');
    checkOutgoingRefusal(output, 'schema-probe');
  `);
  assert.equal(entries.length, 1, 'schema text passes and recording cannot erase a parameter violation');
  const [entry] = entries;
  assert.equal(entry.kind, 'parameter');
  assert.equal(entry.builder, 'orderRuleMessage');
  assert.equal(entry.key, 'repository-path');
  assert.equal(entry.parameter, 'reason');
  assert.equal(entry.message, 'hand-written schema refusal');
  assert.notEqual(entry.pid, process.pid);
  assert.match(entry.stack, /checkOrderTextParameters/);
  assert.ok(entry.caller);
});

test('orderInputName formats data without recording it as issued text', () => {
  const entries = runProbe(`
    const name = orderInputName('scope');
    assert.equal(name, '\`scope:\`');
    checkOrderTextParameters('schema-data-probe', null, { message: name }, []);
    const output = orderRuleMessage('header-shell-safety', { labelName: name, sequence: ';' });
    checkOutgoingRefusal(output, 'schema-probe');
  `);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'parameter');
  assert.equal(entries[0].builder, 'schema-data-probe');
  assert.equal(entries[0].parameter, 'message');
  assert.equal(entries[0].message, '`scope:`');
});
