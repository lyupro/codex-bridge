/** Plan_79 B4c: grant refusals keep their bytes while all prose comes from the D3/D4/D6 registry. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeTempTree } from './temp-tree.mjs';
import { ORDER_RULES, orderRuleMessage } from '../src/home/lib/order-rules.mjs';
import { RULES as GRANT_RULES } from '../src/home/lib/order-rules/header-grants.mjs';
import { ORDER_DIAGNOSTICS, orderDiagnosticMessage } from '../src/home/lib/order-diagnostics.mjs';
import { continuationRefusal, retryRefusal, readyGrantLines } from '../src/home/lib/runner/continuation.mjs';
import { advisorTaskArtifact, advisorTaskOrRefuse, adviseSection } from '../src/home/lib/runner/advise-carry.mjs';
import { ADMISSION_FILES } from './order-guard/admission-files.mjs';
import { checkRefusalSites } from './order-guard/refusal-checker.mjs';

// Plan_79 B4c: literal expectations copy the pre-migration sites, independently of the builders.
const repairMessages = [
  ['ready-grant-line', { variant: 'none' }, 'Ready grant line: none (there is no run to continue).'],
  ['ready-grant-line', { variant: 'continue', run: 'B', reason: 'finish tests' },
    'Ready grant line: continue: B — finish tests.'],
  ['ready-grant-line', { variant: 'retry', run: 'B', reason: 'capacity', orderId: 'o' },
    'Ready retry line: retry: B — capacity (repeats that pass under order o).'],
  ['grant-last-run-hint', { variant: 'none' }, 'Last run: none. Outcome: none.'],
  ['grant-last-run-hint', { variant: 'last', run: 'B', status: 'FAIL', reason: 'capacity' },
    'Last run: B. Outcome: FAIL — capacity.'],
  ['ready-grant-line', { variant: 'resume', run: 'B', reason: 'finish advice', orderId: 'o' },
    "Ready resume line: resume: B — finish advice (continues that pass's Codex thread under order o)."],
];
const hints = [4, 1, 2].map((index) => {
  const [key, values] = repairMessages[index];
  return orderRuleMessage(key, values);
}).join(' ');
const common = {
  labelName: '`continue:`', run: 'B', runsRoot: 'C:/runs', lastRun: 'B', orderId: 'o',
  spent: 'C:/runs/A, C:/runs/B', previous: 'C:/runs/B', hints,
  example: '2026-08-05_092913_plan14-build — LIMIT at step 3, tests unwritten',
};
const continuationMessages = [
  ['missing-folder', { run: 'missing' },
    '`continue:` is refused: the orchestrator named run “missing”, but it does not exist as a run folder ' +
      "in this project's runs directory C:/runs. Last run: B. Outcome: FAIL — capacity. " +
      'Ready grant line: continue: B — finish tests. ' +
      'Ready retry line: retry: B — capacity (repeats that pass under order o). ' +
      'Example: `continue: 2026-08-05_092913_plan14-build — LIMIT at step 3, tests unwritten`. ' +
      'Action: ask the orchestrator for an explicit grant naming the run and reason; ' +
      'do not invent or reuse a continuation. The submitted grant was not rewritten.'],
  ['not-last', { run: 'A' },
    "`continue:` is refused: grant A is not the LAST run of this task's chain; the current last run is B. " +
      'A continuation is single-use: continuing the last run appends a later run, so the old grant stops ' +
      'matching by itself — no counter or new state is used. Last run: B. Outcome: FAIL — capacity. ' +
      'Ready grant line: continue: B — finish tests. ' +
      'Ready retry line: retry: B — capacity (repeats that pass under order o). ' +
      'Example: `continue: 2026-08-05_092913_plan14-build — LIMIT at step 3, tests unwritten`. ' +
      'Action: ask the orchestrator for an explicit grant naming the run and reason; ' +
      'do not invent or reuse a continuation.'],
  ['spent', {},
    '`continue:` is refused: order “o” already spent its allowed continuation on C:/runs/A, C:/runs/B. ' +
      'Last run: B. Outcome: FAIL — capacity. Ready grant line: continue: B — finish tests. ' +
      'Ready retry line: retry: B — capacity (repeats that pass under order o). ' +
      'A further pass needs a new order id from the orchestrator.'],
  ['unfinished', {},
    '`continue:` is refused: previous run C:/runs/B has no finished verdict and may still be editing the worktree. ' +
      'Repeat without `continue:` to attach to it. Last run: B. Outcome: FAIL — capacity. ' +
      'Ready grant line: continue: B — finish tests. ' +
      'Ready retry line: retry: B — capacity (repeats that pass under order o).'],
];
const retryMessages = [
  ['missing-folder', { run: 'missing', runsRoot: 'C:/runs' },
    'Retry is refused: missing is not a bare existing run folder in C:/runs.'],
  ['not-last', { run: 'A' },
    "Retry is refused: grant A is not the LAST run of this task's chain; a retry is single-use."],
  ['order-mismatch', { run: 'B', previousOrder: 'other', orderId: 'o' },
    'Retry is refused: run B order_id other differs from order o. ' +
      'A retry repeats its own order; a run without order_id predates orders — start a new order.'],
  ['order-mismatch', { run: 'B', previousOrder: '(missing)', orderId: 'o' },
    'Retry is refused: run B order_id (missing) differs from order o. ' +
      'A retry repeats its own order; a run without order_id predates orders — start a new order.'],
  ['unfinished', { run: 'B', labelName: '`retry:`' },
    'Retry is refused: run B has no finished verdict or its worker may still be alive and writing. ' +
      'Repeat without `retry:` to attach to it.'],
  ['ended-ok', { run: 'B' },
    'Retry is refused: run B ended OK. A retry repeats a failed pass; use continue: for the next pass.'],
];
const resumeMessages = [
  ['missing-folder', { run: 'missing', runsRoot: 'C:/runs' },
    'Resume is refused: missing is not a bare existing run folder in C:/runs.'],
  ['not-last', { run: 'A' },
    "Resume is refused: grant A is not the LAST run of this task's chain; a resume is single-use."],
  ['order-mismatch', { run: 'B', previousOrder: 'other', orderId: 'o' },
    'Resume is refused: run B order_id other differs from order o. ' +
      'A resume continues its own order; a run without order_id predates orders — start a new order.'],
  ['order-mismatch', { run: 'B', previousOrder: '(missing)', orderId: 'o' },
    'Resume is refused: run B order_id (missing) differs from order o. ' +
      'A resume continues its own order; a run without order_id predates orders — start a new order.'],
  ['unfinished', { run: 'B', labelName: '`resume:`' },
    'Resume is refused: run B has no finished verdict or its worker may still be alive and writing. ' +
      'Repeat without `resume:` to attach to it.'],
  ['ended-ok', { run: 'B' },
    "Resume is refused: run B ended OK. A resume continues a failed pass's Codex thread; " +
      'use continue: for the next pass.'],
  ['not-eligible', { run: 'B', blockers: ['stop-record-missing', 'session-evidence-not-observed'] },
    'Resume is refused: run B cannot be resumed: stop-record-missing, session-evidence-not-observed. ' +
      'A retry: grant repeats it on a fresh thread.'],
  ['inputs-unusable', { run: 'B', reasons: ['artifact-missing:schema.json', 'profile-missing'] },
    'Resume is refused: run B cannot be replayed: artifact-missing:schema.json, profile-missing. ' +
      'A retry: grant repeats it on a fresh thread.'],
  ['thread-unreadable', { run: 'B', state: 'unreadable', reason: 'access denied' },
    'Resume is refused: run B Codex thread is unreadable; reason: access denied.'],
  ['thread-advanced-after-stop', { run: 'B', recordedAt: '2026-10-16T09:25:00.000Z', currentAt: '2026-10-16T09:26:00.000Z' },
    'Resume is refused: run B Codex thread advanced after stop: recorded last_record_at ' +
      '2026-10-16T09:25:00.000Z; current last_record_at 2026-10-16T09:26:00.000Z.'],
];
const diagnosticMessages = [
  ['advise-scope-input-required', {}, 'internal',
    'Cannot carry advise scope result: runsRoot and grantRun are required.'],
  ['advise-scope-result-readable', { scopeFile: 'C:/runs/S/result.json', message: 'read failed\nDetails' }, 'run-state',
    'Cannot read advise scope result at C:/runs/S/result.json: read failed\nDetails'],
  ['advise-scope-result-shape', { scopeFile: 'C:/runs/S/result.json' }, 'run-state',
    'Malformed advise scope result at C:/runs/S/result.json: expected predicted_risks and missing_paths arrays.'],
];

for (const [key, messages, defaults] of [
  ['continuation-grant-usable', continuationMessages, common],
  ['retry-grant-usable', retryMessages, {}],
  ['resume-grant-usable', resumeMessages, {}],
]) {
  for (const [violation, values, expected] of messages) {
    test(`${key} ${violation} ${JSON.stringify(values)} preserves literal text`, () => {
      const input = { ...defaults, ...values, violation };
      assert.equal(orderRuleMessage(key, input), expected);
      assert.equal(ORDER_RULES[key].message(input), expected);
    });
  }
}
for (const [key, values, expected] of repairMessages) {
  test(`${key} ${values.variant} preserves the literal repair text`, () => {
    assert.equal(orderRuleMessage(key, values), expected);
    assert.equal(ORDER_RULES[key].message(values), expected);
  });
}
for (const [key, values, category, expected] of diagnosticMessages) {
  test(`${key} preserves the literal ${category} diagnostic`, () => {
    assert.equal(orderDiagnosticMessage(key, values), expected);
    assert.equal(ORDER_DIAGNOSTICS[key].message(values), expected);
    assert.equal(ORDER_DIAGNOSTICS[key].category, category);
  });
}

test('grant rules are frozen header grant rules with explicit data and author guidance', () => {
  for (const key of ['continuation-grant-usable', 'retry-grant-usable', 'resume-grant-usable',
    'ready-grant-line', 'grant-last-run-hint']) {
    const entry = ORDER_RULES[key];
    assert.equal(entry, GRANT_RULES[key]);
    assert.equal(entry.topic, 'order');
    assert.ok(entry.rule.trim());
    assert.ok(Object.isFrozen(entry));
    assert.ok(Object.isFrozen(entry.data));
    assert.ok(!entry.data.includes('hints'), 'forwarded hints are text, not data');
    assert.ok(!entry.message.toString().includes('The run folder was not created; quota was not spent.'));
  }
});

test('grant selectors reject absent and unknown violations and variants without a default', () => {
  for (const [key, selector] of [
    ['continuation-grant-usable', 'violation'], ['retry-grant-usable', 'violation'],
    ['resume-grant-usable', 'violation'],
    ['ready-grant-line', 'variant'], ['grant-last-run-hint', 'variant'],
  ]) {
    for (const value of [undefined, 'unknown', 'toString', '__proto__']) {
      assert.throws(() => orderRuleMessage(key, { [selector]: value }), {
        message: `unknown ${key} ${selector}: ${value}`,
      });
    }
  }
});

for (const name of ['continuation', 'continuation-outcome', 'advise-carry']) {
  test(`${name} passes the static guard without pending migration or opt-outs`, () => {
    const file = `src/home/lib/runner/${name}.mjs`;
    assert.ok(ADMISSION_FILES.includes(file));
    const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.deepEqual(checkRefusalSites(source, file), { violations: [], optOuts: [] });
    assert.doesNotMatch(source, /recordOrderText|pending producer|order-guard: not-a-refusal/);
  });
}

function writeRun(root, name, status, meta) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(status) + '\n');
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta) + '\n');
}
const grant = (run) => ({ run, reason: 'finish tests' });
const suffix = ' The run folder was not created; quota was not spent.';
const atRoot = (text, root) => text.replaceAll('C:/runs/A', path.join(root, 'A'))
  .replaceAll('C:/runs/B', path.join(root, 'B')).replaceAll('C:/runs', root);

test('continuation callers preserve every complete refusal and null success', () => {
  const root = makeTempTree('order-rules-grants-continue-');
  const status = { state: 'finished', order_id: 'o' };
  const meta = { status: 'FAIL', reason: 'capacity' };
  for (const name of ['A', 'B']) writeRun(root, name, status, meta);
  for (const [index, chain, run] of [[0, ['A', 'B'], 'missing'], [1, ['A', 'B'], 'A'], [2, ['A', 'B'], 'B']]) {
    assert.equal(continuationRefusal(root, chain, true, 'o', grant(run)),
      atRoot(continuationMessages[index][2], root) + suffix);
  }
  writeRun(root, 'B', { ...status, state: 'running' }, meta);
  assert.equal(continuationRefusal(root, ['B'], true, 'o', grant('B')),
    atRoot(continuationMessages[3][2], root) + suffix);
  writeRun(root, 'B', status, meta);
  assert.equal(continuationRefusal(root, ['B'], true, 'o', grant('B')), null);
  assert.equal(continuationRefusal(root, ['B'], true, 'new-order', grant('B')), null);
  for (const input of [undefined, null, 'continue: B — finish tests', { run: 'B' }]) {
    assert.equal(continuationRefusal(root, ['B'], true, 'o', input), null);
  }
  assert.equal(continuationRefusal(root, ['A', 'B'], false, 'o', grant('B')), null);
  const empty = continuationRefusal(root, [], true, 'o', grant('missing'));
  assert.ok(empty.includes('Last run: none. Outcome: none. Ready grant line: none (there is no run to continue).'));
  assert.deepEqual(fs.readdirSync(root).sort(), ['A', 'B']);
});

test('retry callers preserve every complete refusal, gate priority and null success', () => {
  const root = makeTempTree('order-rules-grants-retry-');
  const status = { state: 'finished', order_id: 'o' };
  const meta = { status: 'FAIL', reason: 'capacity' };
  const unexpected = () => assert.fail('an earlier gate must refuse before liveness');
  for (const name of ['A', 'B']) writeRun(root, name, status, meta);
  assert.equal(retryRefusal(root, ['B'], true, 'o', grant('missing'), unexpected),
    atRoot(retryMessages[0][2], root) + suffix);
  assert.equal(retryRefusal(root, ['A', 'B'], true, 'o', grant('A'), unexpected), retryMessages[1][2] + suffix);
  for (const [index, order_id] of [[2, 'other'], [3, '']]) {
    writeRun(root, 'B', { ...status, order_id }, meta);
    assert.equal(retryRefusal(root, ['B'], true, 'o', grant('B'), unexpected), retryMessages[index][2] + suffix);
  }
  writeRun(root, 'B', status, {});
  assert.equal(retryRefusal(root, ['B'], true, 'o', grant('B'), unexpected), retryMessages[4][2] + suffix);
  writeRun(root, 'B', status, { status: 'OK' });
  assert.equal(retryRefusal(root, ['B'], true, 'o', grant('B'), () => true), retryMessages[4][2] + suffix);
  assert.equal(retryRefusal(root, ['B'], true, 'o', grant('B'), () => false), retryMessages[5][2] + suffix);
  for (const verdict of ['FAIL', 'LIMIT', 'UNAVAILABLE']) {
    writeRun(root, 'B', status, { status: verdict });
    assert.equal(retryRefusal(root, ['B'], true, 'o', grant('B'), () => false), null);
  }
  assert.deepEqual(fs.readdirSync(root).sort(), ['A', 'B']);
});

test('ready grant callers preserve reason selection and retry eligibility', () => {
  const root = makeTempTree('order-rules-grants-ready-');
  assert.equal(readyGrantLines(root, []), repairMessages[0][2]);
  const status = { state: 'finished', order_id: ' o ', reason: 'status reason' };
  for (const verdict of ['FAIL', 'LIMIT', 'UNAVAILABLE']) {
    writeRun(root, 'B', status, { status: verdict, reason: ' capacity ' });
    assert.equal(readyGrantLines(root, ['B'], ' finish tests '), repairMessages[1][2] + ' ' + repairMessages[2][2]);
    assert.equal(readyGrantLines(root, ['B'], ' '),
      'Ready grant line: continue: B — capacity. Ready retry line: retry: B — capacity (repeats that pass under order o).');
  }
  for (const [record, verdict] of [[status, 'OK'], [{ state: 'finished' }, 'FAIL'], [status, undefined]]) {
    writeRun(root, 'B', record, { status: verdict, reason: 'capacity' });
    assert.equal(readyGrantLines(root, ['B']), 'Ready grant line: continue: B — capacity.');
  }
});

test('advise carry keeps diagnostic forwarding, exit code and prompt bytes', () => {
  const taskText = '## Options\n- keep: Keep.\n- split: Split.\n## Paths\n- src/a.mjs\n';
  const input = { taskText, phase: 'advise' };
  assert.throws(() => advisorTaskArtifact(input), { message: diagnosticMessages[0][3] });
  assert.throws(() => advisorTaskOrRefuse(input), (error) => {
    assert.equal(error.message, diagnosticMessages[0][3] + suffix + '\n' + orderDiagnosticMessage('next-action', { variant: 'advisor-scope-result' }));
    assert.deepEqual(error.message.split('\n').filter((line) => line.startsWith('Action: ')),
      [orderDiagnosticMessage('next-action', { variant: 'advisor-scope-result' })]);
    assert.equal(error.exitCode, 1);
    return true;
  });
  const root = makeTempTree('order-rules-grants-carry-');
  fs.mkdirSync(path.join(root, 'S'));
  fs.writeFileSync(path.join(root, 'S', 'result.json'), '{}\n');
  const malformed = 'Malformed advise scope result at ' + path.join(root, 'S', 'result.json') +
    ': expected predicted_risks and missing_paths arrays.';
  assert.throws(() => advisorTaskOrRefuse({ ...input, runsRoot: root, grantRun: 'S' }), (error) => {
    assert.equal(error.message, malformed + suffix + '\n' + orderDiagnosticMessage('next-action', { variant: 'advisor-scope-result' }));
    assert.deepEqual(error.message.split('\n').filter((line) => line.startsWith('Action: ')),
      [orderDiagnosticMessage('next-action', { variant: 'advisor-scope-result' })]);
    assert.equal(error.exitCode, 1);
    return true;
  });
  assert.equal(adviseSection(null), '');
  assert.equal(adviseSection({ scope: { predicted_risks: [{ id: 'r1', risk: 'Risk.' }], missing_paths: ['src/a.mjs'] } }),
    '## Scope phase results\n\nPredicted risks:\n- r1: Risk.\n\nPaths you may additionally read and cite:\n- src/a.mjs');
});

// Plan_79 D6: the intentional laundering probe has its own child-process marker directory.
test('issued hints compose cleanly and handwritten hints journal a parameter violation', () => {
  const root = path.join(makeTempTree('order-rules-grants-params-'), 'marker');
  const rules = new URL('../src/home/lib/order-rules.mjs', import.meta.url).href;
  const diagnostics = new URL('../src/home/lib/order-diagnostics.mjs', import.meta.url).href;
  const recorder = new URL('../src/home/lib/order-text-record.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { orderRuleMessage } from ${JSON.stringify(rules)};
    import { orderDiagnosticMessage } from ${JSON.stringify(diagnostics)};
    import { checkOutgoingRefusal } from ${JSON.stringify(recorder)};
    const repairs = ${JSON.stringify(repairMessages)};
    for (const [key, values, expected] of repairs) {
      const text = orderRuleMessage(key, values);
      assert.equal(text, expected);
      checkOutgoingRefusal(text, 'grants-probe');
    }
    const hints = [4, 1, 2].map((index) => orderRuleMessage(repairs[index][0], repairs[index][1])).join(' ');
    for (const [key, messages, defaults] of ${JSON.stringify([
      ['continuation-grant-usable', continuationMessages, common], ['retry-grant-usable', retryMessages, {}],
      ['resume-grant-usable', resumeMessages, {}],
    ])}) {
      for (const [violation, values, expected] of messages) {
        const input = { ...defaults, ...values, violation };
        if (key === 'continuation-grant-usable') input.hints = hints;
        const text = orderRuleMessage(key, input);
        assert.equal(text, expected);
        checkOutgoingRefusal([text, orderDiagnosticMessage('run-not-created')].join(' '), 'grants-probe');
      }
    }
    for (const [key, values, , expected] of ${JSON.stringify(diagnosticMessages)}) {
      const text = orderDiagnosticMessage(key, values);
      assert.equal(text, expected);
      checkOutgoingRefusal([text, orderDiagnosticMessage('run-not-created')].join(' '), 'grants-probe');
    }
    const text = orderRuleMessage('continuation-grant-usable', {
      violation: 'unfinished', labelName: ${JSON.stringify('`continue:`')}, previous: 'C:/runs/B', hints: 'hand-written grant refusal',
    });
    checkOutgoingRefusal(text, 'grants-probe');
  `], { env: { ...process.env, CODEX_BRIDGE_TEST_TMP: root }, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const directory = path.join(root, 'order-text-violations');
  const entries = fs.readdirSync(directory).flatMap((file) =>
    fs.readFileSync(path.join(directory, file), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'parameter');
  assert.equal(entries[0].builder, 'orderRuleMessage');
  assert.equal(entries[0].key, 'continuation-grant-usable');
  assert.equal(entries[0].parameter, 'hints');
  assert.equal(entries[0].message, 'hand-written grant refusal');
  assert.notEqual(entries[0].pid, process.pid);
  assert.match(entries[0].stack, /checkOrderTextParameters/);
  assert.ok(entries[0].caller);
});
