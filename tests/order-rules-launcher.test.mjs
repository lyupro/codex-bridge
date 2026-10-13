/** Plan_79 B4f D3-D7: launcher refusals preserve their bytes and use only issued registry text. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ORDER_RULES, orderLabelReason, orderRuleMessage } from '../src/home/lib/order-rules.mjs';
import { ORDER_DIAGNOSTICS, orderDiagnosticMessage } from '../src/home/lib/order-diagnostics.mjs';
import { RULES as HEADER_RULES } from '../src/home/lib/order-rules/header.mjs';
import { DIAGNOSTICS as HOST_DIAGNOSTICS } from '../src/home/lib/order-diagnostics/host-state.mjs';
import { DIAGNOSTICS as RUN_DIAGNOSTICS } from '../src/home/lib/order-diagnostics/run-state.mjs';
import { orderInputName } from '../src/home/lib/order-schema.mjs';
import { validateScope } from '../src/home/lib/runner/scope-check.mjs';
import { makeRunDir, runDirPath } from '../src/home/lib/runner/launcher.mjs';
import { staleOverrideRefusal } from '../src/home/lib/runner/runs-root.mjs';
import { checkOutgoingRefusal } from '../src/home/lib/order-text-record.mjs';
import { ADMISSION_FILES } from './order-guard/admission-files.mjs';
import { checkRefusalSites } from './order-guard/refusal-checker.mjs';
import { makeTempTree } from './temp-tree.mjs';

const scopeCases = [
  ['scope', '/src/a.mjs',
    '`scope:` pattern "/src/a.mjs" refused: is an absolute or drive-qualified path. ' +
      'Action: use a path relative to the repository root with forward slashes. ' +
      'The run folder was not created; quota was not spent.'],
  ['scope new', 'src/',
    '`scope new:` pattern "src/" refused: names a directory rather than a file. ' +
      'Action: write src/** for everything inside it, or name the file itself. ' +
      'The run folder was not created; quota was not spent.'],
  ['scope', 'src/a\nb.mjs',
    '`scope:` pattern "src/a\\nb.mjs" refused: contains a newline or carriage return. ' +
      'Action: use a glob instead of a literal path containing a line break. ' +
      'The run folder was not created; quota was not spent.'],
  ['scope new', 'areas/Ω file/',
    '`scope new:` pattern "areas/Ω file/" refused: names a directory rather than a file. ' +
      'Action: write areas/Ω file/** for everything inside it, or name the file itself. ' +
      'The run folder was not created; quota was not spent.'],
];

for (const [label, pattern, expected] of scopeCases) {
  test(`launcher scope composition preserves ${label} ${JSON.stringify(pattern)}`, () => {
    const repoRoot = makeTempTree('order-rules-launcher-scope-');
    const refusal = validateScope(repoRoot, label === 'scope' ? [pattern] : [],
      label === 'scope new' ? [pattern] : []);
    assert.equal(refusal.label, label);
    const text = [orderLabelReason(orderInputName(refusal.label), orderRuleMessage('scope-pattern-refusal', {
      pattern: refusal.pattern, reason: refusal.reason, action: refusal.action,
    })), orderDiagnosticMessage('run-not-created')].join(' ');
    assert.equal(text, expected);
    assert.equal(checkOutgoingRefusal(text, 'launcher-test'), expected);
  });
}

test('launcher composition also accepts scope match rule outputs', () => {
  const text = [orderLabelReason(orderInputName('scope'), orderRuleMessage('scope-pattern-refusal', {
    pattern: 'missing.mjs',
    reason: orderRuleMessage('scope-pattern-match', { violation: 'missing', part: 'reason' }),
    action: orderRuleMessage('scope-pattern-match', {
      violation: 'missing', part: 'action', labelName: orderInputName('scope new'),
    }),
  })), orderDiagnosticMessage('run-not-created')].join(' ');
  const expected = '`scope:` pattern "missing.mjs" refused: does not match any existing path in the repository. ' +
    'Action: correct the pattern or declare an intentionally new path with `scope new:`. ' +
    'The run folder was not created; quota was not spent.';
  assert.equal(text, expected);
  assert.equal(checkOutgoingRefusal(text, 'launcher-test'), expected);
});

test('stale runs root refusal keeps its three lines without new launcher prose', () => {
  const root = path.resolve('old-runs');
  const destination = path.resolve('new-runs');
  const text = [staleOverrideRefusal({
    root, homeRoot: destination, staleOverride: { root, suffix: '' },
  }), orderDiagnosticMessage('run-not-created')].join('\n');
  const expected = `Run records moved from ${root} to ${destination}. Equivalent path: ${destination}. ` +
    'Update advice: or pass this new path explicitly. No path was remapped.\n' +
    'CODEX_RUNS_ROOT points under a retired runs root; remove it or set it to the new location.\n' +
    'The run folder was not created; quota was not spent.';
  assert.equal(text, expected);
  assert.equal(checkOutgoingRefusal(text, 'launcher-test'), expected);
});

test('abandoned run diagnostic keeps the branch repair and original trailing sentence', () => {
  const text = orderDiagnosticMessage('repository-detached-after-abandoned-run', {
    run: '2026-10-13_144125_abandoned', branch: 'feature/Ω-launcher',
  });
  const expected = 'repository is detached after abandoned run 2026-10-13_144125_abandoned, ' +
    'which recorded branch feature/Ω-launcher. Return with: git checkout feature/Ω-launcher. ' +
    'No run folder was created and no quota was spent.';
  assert.equal(text, expected);
  assert.equal(checkOutgoingRefusal(text, 'launcher-test'), expected);
});

for (const [key, values, expected] of [
  ['cmd-argument-transport', { argument: 'C:/work/%USER%/"task"' },
    'argument cannot be passed through cmd.exe (contains % or "): C:/work/%USER%/"task"'],
  ['run-worker-start-failure', { message: 'spawn C:/node.exe ENOENT' },
    'run worker process failed to start: spawn C:/node.exe ENOENT'],
]) {
  test(`${key} preserves the failure reason and shares the no-start line`, () => {
    const reason = orderDiagnosticMessage(key, values);
    const extra = orderDiagnosticMessage('codex-not-started');
    assert.equal(reason, expected);
    assert.equal(extra, 'Codex was not started; quota was not spent');
    assert.equal(checkOutgoingRefusal([reason, extra].join('\n'), 'launcher-test'),
      expected + '\nCodex was not started; quota was not spent');
  });
}

test('launcher entries belong to their header, host and run owners with explicit data', () => {
  assert.equal(ORDER_RULES['scope-pattern-refusal'], HEADER_RULES['scope-pattern-refusal']);
  assert.equal(ORDER_RULES['scope-pattern-refusal'].topic, 'order');
  assert.deepEqual(ORDER_RULES['scope-pattern-refusal'].data, ['pattern']);
  for (const [owner, category, entries] of [
    [HOST_DIAGNOSTICS, 'host-state', [
      ['cmd-argument-transport', ['argument']], ['run-worker-start-failure', ['message']],
    ]],
    [RUN_DIAGNOSTICS, 'run-state', [
      ['repository-detached-after-abandoned-run', ['run', 'branch']], ['codex-not-started', []],
    ]],
  ]) {
    for (const [key, data] of entries) {
      assert.equal(ORDER_DIAGNOSTICS[key], owner[key]);
      assert.equal(ORDER_DIAGNOSTICS[key].category, category);
      assert.ok(Object.isFrozen(ORDER_DIAGNOSTICS[key]));
      assert.ok(Object.isFrozen(ORDER_DIAGNOSTICS[key].data));
      assert.deepEqual(ORDER_DIAGNOSTICS[key].data, data);
    }
  }
});

test('unknown launcher registry selectors and scope-check selectors throw', () => {
  assert.throws(() => orderRuleMessage('unknown-launcher-rule'), {
    message: 'unknown order rule: unknown-launcher-rule',
  });
  assert.throws(() => orderDiagnosticMessage('unknown-launcher-diagnostic'), {
    message: 'unknown order diagnostic: unknown-launcher-diagnostic',
  });
  assert.throws(() => orderRuleMessage('scope-pattern-shape', { violation: 'absolute', part: 'unknown' }), {
    message: 'unknown scope-pattern-shape part: unknown',
  });
});

test('launcher is admitted without pending migration, recording or guard opt-outs', () => {
  const file = 'src/home/lib/runner/launcher.mjs';
  const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  assert.ok(ADMISSION_FILES.includes(file));
  assert.deepEqual(checkRefusalSites(source, file), { violations: [], optOuts: [] });
  assert.doesNotMatch(source, /recordOrderText|pending producer/);
  assert.ok(source.trimEnd().split(/\r?\n/).length <= 400);
});

// Plan_79 B4f D5: non-refusal path composition must pass the guard without an exemption or a behavior change.
test('launcher path joins retain the timestamp shape and collision suffixes', () => {
  const root = makeTempTree('order-rules-launcher-paths-');
  const stamped = runDirPath(root, '2026-10-13_launcher');
  assert.match(path.basename(stamped), /^\d{4}-\d{2}-\d{2}_\d{6}_launcher$/);
  const base = runDirPath(root, '2026-10-13_launcher', '2026-10-13_040506');
  assert.equal(path.basename(base), '2026-10-13_040506_launcher');
  assert.equal(makeRunDir(base), base);
  assert.equal(makeRunDir(base), base + '-2');
  assert.equal(makeRunDir(base), base + '-3');
});

test('D6 launcher probe journals handwritten reason text in a separate child marker', () => {
  const root = path.join(makeTempTree('order-rules-launcher-params-'), 'marker');
  const lib = new URL('../src/home/lib/', import.meta.url);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { orderLabelReason, orderRuleMessage } from ${JSON.stringify(new URL('order-rules.mjs', lib).href)};
    import { orderDiagnosticMessage } from ${JSON.stringify(new URL('order-diagnostics.mjs', lib).href)};
    import { orderInputName } from ${JSON.stringify(new URL('order-schema.mjs', lib).href)};
    import { checkOutgoingRefusal } from ${JSON.stringify(new URL('order-text-record.mjs', lib).href)};
    const reason = orderRuleMessage('scope-pattern-shape', { violation: 'absolute', part: 'reason' });
    const action = orderRuleMessage('scope-pattern-shape', { violation: 'absolute', part: 'action' });
    const known = [orderLabelReason(orderInputName('scope'), orderRuleMessage('scope-pattern-refusal', {
      pattern: '/a.mjs', reason, action,
    })), orderDiagnosticMessage('run-not-created')].join(' ');
    checkOutgoingRefusal(known, 'launcher-probe');
    for (const [key, values] of [
      ['cmd-argument-transport', { argument: 'unsafe % or " argument' }],
      ['run-worker-start-failure', { message: 'arbitrary system error' }],
      ['repository-detached-after-abandoned-run', { run: 'arbitrary run', branch: 'arbitrary branch' }],
      ['codex-not-started', {}],
    ]) checkOutgoingRefusal(orderDiagnosticMessage(key, values), 'launcher-probe');
    const text = orderRuleMessage('scope-pattern-refusal', {
      pattern: '/a.mjs', reason: 'hand-written launcher refusal', action,
    });
    assert.equal(text, 'pattern "/a.mjs" refused: hand-written launcher refusal. ' +
      'Action: use a path relative to the repository root with forward slashes.');
    checkOutgoingRefusal(text, 'launcher-probe');
  `], { env: { ...process.env, CODEX_BRIDGE_TEST_TMP: root }, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const directory = path.join(root, 'order-text-violations');
  const entries = fs.readdirSync(directory).flatMap((file) =>
    fs.readFileSync(path.join(directory, file), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse));
  assert.equal(entries.length, 1);
  const [entry] = entries;
  assert.equal(entry.kind, 'parameter');
  assert.equal(entry.builder, 'orderRuleMessage');
  assert.equal(entry.key, 'scope-pattern-refusal');
  assert.equal(entry.parameter, 'reason');
  assert.equal(entry.message, 'hand-written launcher refusal');
  assert.notEqual(entry.pid, process.pid);
  assert.match(entry.stack, /checkOrderTextParameters/);
  assert.ok(entry.caller);
});
