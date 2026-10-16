/** Plan_79 B4d: literal pre-migration messages guard pass gates, host readiness and D6 text inputs. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeTempTree } from './temp-tree.mjs';
import { ORDER_RULES, orderRuleMessage } from '../src/home/lib/order-rules.mjs';
import { ORDER_DIAGNOSTICS, orderDiagnosticMessage } from '../src/home/lib/order-diagnostics.mjs';
import { RULES as GRANT_RULES } from '../src/home/lib/order-rules/header-grants.mjs';
import { RULES as HEADER_RULES } from '../src/home/lib/order-rules/header.mjs';
import { RULES as CALL_RULES } from '../src/home/lib/order-rules/call.mjs';
import { DIAGNOSTICS as HOST_DIAGNOSTICS } from '../src/home/lib/order-diagnostics/host-state.mjs';
import { passGate } from '../src/home/lib/runner/pass-gate.mjs';
import {
  codexAvailabilityRefusal, taskPreflight, scopeRunRefusal, resolveRunPhase, preflightRefusal,
} from '../src/home/lib/runner/preflight.mjs';
import { ADMISSION_FILES } from './order-guard/admission-files.mjs';
import { checkRefusalSites } from './order-guard/refusal-checker.mjs';

const suffix = 'The run folder was not created; quota was not spent.';
const labels = { phaseLabel: '`phase:`', continueLabel: '`continue:`' };
const hint = orderRuleMessage('ready-grant-line', { variant: 'none' });
const repeat = {
  continueLabel: '`continue:`', slugLabel: '`slug:`', slug: 'task', count: 2, latest: 'C:/runs/B', hints: hint,
};
// Plan_79 B4d: expectations are copied from today's sites, never computed by the entries under test.
const messages = [
  ['advisor-scope-continuation', labels,
    'codex-advisor `phase:` scope refuses `continue:`: a scope pass is never continued, and continuing one ' +
      "spends the order's single continuation that its advise phase needs. Action: repeat the scope under a new order id " +
      "without `continue:` and without a continue: grant, then run advise as that order's continuation; a " +
      'scope run that failed is repeated with a `retry:` grant instead.'],
  ['retry-pass-identity', { agent: 'codex-advisor', phase: 'scope' },
    "a retry repeats the named run's own agent and phase: codex-advisor/scope."],
  ['retry-pass-identity', { agent: 'codex-build', phase: undefined },
    "a retry repeats the named run's own agent and phase: codex-build/undefined."],
  ['repeat-task-grant-required', { ...repeat, violation: 'existing' },
    '`continue:` is required: runs for task “task” already exist in this repository (2), latest: C:/runs/B. ' +
      'A repeat run is allowed, but the orchestrator decides, not the runner: it read the ' +
      'previous response and knows whether work remains. Add `continue:` if you are finishing ' +
      'the same task; changing `slug:` with the same task text does not stop it being a repeat. ' +
      'Ready grant line: none (there is no run to continue).'],
  ['repeat-task-grant-required', { ...repeat, violation: 'renamed' },
    '`continue:` is required: this task already ran in this repository under the name “task” (2), latest: C:/runs/B. ' +
      'A repeat run is allowed, but the orchestrator decides, not the runner: it read the ' +
      'previous response and knows whether work remains. Add `continue:` if you are finishing ' +
      'the same task; changing `slug:` with the same task text does not stop it being a repeat. ' +
      'Ready grant line: none (there is no run to continue).'],
  ['advisor-advise-continuation', labels,
    'codex-advisor `phase:` advise requires a `continue:` grant naming the scope run: phase 2 continues the scope run of the same order ' +
      'so it can settle the risks phase 1 predicted.'],
  ['build-advice-required', {},
    'codex-build requires the task file to start with the header line `advice: <value>`, where the ' +
      'value is mechanical | revert | docs-only | test-only ' +
      'or an absolute path to an existing advisor run directory whose meta.json says agent codex-advisor, ' +
      'phase advise, status OK. ' +
      'An order that invents a construction needs a second opinion first; only work with no design choice may skip it.'],
  ['advise-scope-run-required', { violation: 'agent' }, "agent must be 'codex-advisor'"],
  ['advise-scope-run-required', { violation: 'phase' }, "phase must be 'scope'"],
  ['advise-scope-run-required', { violation: 'status' }, "status must be 'OK'"],
  ['run-phase-required', { violation: 'missing', phaseLabel: '`phase:`', agent: 'codex-advisor', names: ['scope', 'advise'] },
    '`phase:` is required for codex-advisor. Action: pass `phase:` <name>; allowed phases: scope, advise.'],
  ['run-phase-required', { violation: 'undeclared', phaseLabel: '`phase:`', phase: 'bad "phase"\n', agent: 'codex-build', names: ['default'] },
    'undeclared `phase:` "bad \\"phase\\"\\n" for codex-build. Action: pass `phase:` <name>; allowed phases: default.'],
  ['writing-run-exclusive', { run: 'B', activePath: 'C:/runs/B', identity: 'matched' },
    'run B is already active for this repository; two writing runs in one tree are prohibited\nActive run: C:/runs/B'],
  ['writing-run-exclusive', { run: 'B', activePath: 'C:/runs/B', identity: 'unverified' },
    'run B is already active for this repository; two writing runs in one tree are prohibited; process identity could not be confirmed\nActive run: C:/runs/B'],
  ['resume-pass-identity', { agent: 'codex-advisor', phase: 'advise' },
    "a resume continues the named run's own agent and phase: codex-advisor/advise."],
  ['resume-pass-identity', { agent: 'codex-scout', phase: 'default' },
    "a resume continues the named run's own agent and phase: codex-scout/default."],
];
const hostMessages = [
  ['codex-readiness-unconfirmed', { detail: 'PATH miss\nDetails' },
    'Codex CLI readiness unconfirmed: PATH miss\nDetails\n' +
      'Do not skip this bridge: check codex --version for up to about 2 minutes; when it answers, repeat the same order exactly once; if it does not answer, hand the order to the next executor and name that in the summary.'],
  ['codex-unavailable', { detail: 'probe timed out\nDetails' },
    'Codex CLI unavailable: probe timed out\nDetails\n' +
      'Operator check: codex --version (and codex login if authorization is rejected)'],
];
for (const [index, [key, values, expected]] of messages.entries()) {
  test(`${key} literal message ${index}`, () => {
    assert.equal(orderRuleMessage(key, values), expected);
    assert.equal(ORDER_RULES[key].message(values), expected);
  });
}
for (const [key, values, expected] of hostMessages) {
  test(`${key} preserves every host row and detail byte`, async () => {
    assert.equal(orderDiagnosticMessage(key, values), expected);
    assert.equal(ORDER_DIAGNOSTICS[key].message(values), expected);
    assert.deepEqual(await codexAvailabilityRefusal({ probe: async () => ({
      state: 'inconclusive', pathMiss: key === 'codex-readiness-unconfirmed', detail: values.detail,
    }) }), { unavailable: false, text: expected + '\n' + suffix });
  });
}

test('entries live in their declared places, freeze data and reuse the run-state suffix', () => {
  for (const [owners, keys] of [
    [GRANT_RULES, ['advisor-scope-continuation', 'retry-pass-identity', 'resume-pass-identity', 'repeat-task-grant-required',
      'advisor-advise-continuation', 'build-advice-required', 'advise-scope-run-required']],
    [HEADER_RULES, ['run-phase-required']], [CALL_RULES, ['writing-run-exclusive']],
  ]) {
    for (const key of keys) {
      const entry = ORDER_RULES[key];
      assert.equal(entry, owners[key]);
      assert.equal(entry.topic, 'order');
      assert.ok(entry.rule.trim());
      assert.ok(Object.isFrozen(entry) && Object.isFrozen(entry.data));
      assert.ok(!entry.data.includes('hints') && !entry.data.includes('failed'));
      assert.ok(!entry.message.toString().includes(suffix));
    }
  }
  for (const [key] of hostMessages) {
    assert.equal(ORDER_DIAGNOSTICS[key], HOST_DIAGNOSTICS[key]);
    assert.equal(ORDER_DIAGNOSTICS[key].category, 'host-state');
    assert.ok(Object.isFrozen(ORDER_DIAGNOSTICS[key].data));
  }
});

test('unknown and absent violations throw instead of selecting a default', () => {
  for (const key of ['repeat-task-grant-required', 'advise-scope-run-required', 'run-phase-required']) {
    for (const violation of [undefined, 'unknown', 'toString', '__proto__']) {
      assert.throws(() => orderRuleMessage(key, { violation }), { message: `unknown ${key} violation: ${violation}` });
    }
  }
});

for (const name of ['pass-gate', 'preflight']) {
  test(`${name} passes admission without pending migration or opt-outs`, () => {
    const file = `src/home/lib/runner/${name}.mjs`;
    assert.ok(ADMISSION_FILES.includes(file));
    const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.deepEqual(checkRefusalSites(source, file), { violations: [], optOuts: [] });
    assert.doesNotMatch(source, /recordOrderText|pending producer|order-guard: not-a-refusal/);
    assert.ok(!source.includes(suffix));
  });
}

function writeRun(root, status, meta) {
  const directory = path.join(root, 'B');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'status.json'), JSON.stringify(status) + '\n');
  fs.writeFileSync(path.join(directory, 'meta.json'), JSON.stringify(meta) + '\n');
  return directory;
}
const usage = (expected, exitCode = 2) => (error) => {
  assert.equal(error.message, expected);
  assert.equal(error.exitCode, exitCode);
  return true;
};

test('phase callers preserve full refusal bytes, exit codes and default success', () => {
  const budgets = { advisor: { scope: 15, advise: 15 }, build: { default: 15 } };
  assert.throws(() => resolveRunPhase({ agent: 'codex-advisor', phase: 'advise', continue: false }, budgets),
    usage(messages[5][2] + ' ' + suffix));
  assert.throws(() => resolveRunPhase({ agent: 'codex-advisor' }, budgets), usage(messages[10][2] + ' ' + suffix));
  assert.throws(() => resolveRunPhase({ agent: 'codex-build', phase: 'bad "phase"\n' }, budgets),
    usage(messages[11][2] + ' ' + suffix));
  assert.equal(resolveRunPhase({ agent: 'codex-build' }, budgets), 'default');
  assert.equal(resolveRunPhase({ agent: 'codex-advisor', phase: 'advise', continue: true }, budgets), 'advise');
});

test('scope metadata preserves failure order, all subsets and null success', () => {
  const root = makeTempTree('passes-scope-');
  const input = { agent: 'codex-advisor', phase: 'advise', runsRoot: root, grantRun: 'B' };
  for (let mask = 0; mask < 8; mask += 1) {
    writeRun(root, {}, { agent: mask & 1 ? 'wrong' : 'codex-advisor', phase: mask & 2 ? 'advise' : 'scope', status: mask & 4 ? 'FAIL' : 'OK' });
    const failed = [mask & 1 ? "agent must be 'codex-advisor'" : null,
      mask & 2 ? "phase must be 'scope'" : null, mask & 4 ? "status must be 'OK'" : null].filter(Boolean);
    assert.equal(scopeRunRefusal(input), mask ? 'continued run meta.json failed ' + failed.join(', ') + '. ' + suffix : null);
  }
  assert.equal(scopeRunRefusal({ ...input, grantRun: 'missing' }),
    "continued run meta.json failed agent must be 'codex-advisor', phase must be 'scope', status must be 'OK'. " + suffix);
  assert.equal(scopeRunRefusal({ ...input, phase: 'scope' }), null);
  assert.equal(scopeRunRefusal({ ...input, agent: 'codex-build' }), null);
});

test('build advice callers preserve refusal, accepted exemptions and valid evidence', () => {
  const resolution = { retired: [], homeRoot: 'C:/new' };
  const input = { agent: 'codex-build', taskText: '', header: { advice: null }, resolution };
  assert.deepEqual(taskPreflight(input), { refusal: messages[6][2] + '\n' + suffix });
  for (const advice of ['mechanical', 'revert', 'docs-only', 'test-only']) {
    assert.deepEqual(taskPreflight({ ...input, header: { advice } }), { refusal: null, advice });
  }
  const root = makeTempTree('passes-advice-');
  const advice = writeRun(root, {}, { agent: 'codex-advisor', phase: 'advise', status: 'OK' });
  assert.deepEqual(taskPreflight({ ...input, header: { advice } }), { refusal: null, advice });
  assert.deepEqual(taskPreflight({ ...input, agent: 'codex-scout' }), { refusal: null });
});

test('busy-tree callers preserve both identity rows and do not refuse read-only agents', () => {
  for (const identity of ['alive', 'unverified']) {
    const root = makeTempTree('passes-busy-');
    const directory = writeRun(root, { state: 'running', agent: 'codex-build', repo: root, pid: process.pid }, {});
    if (identity === 'alive') fs.writeFileSync(path.join(directory, 'heartbeat'), 'fresh\n');
    const note = identity === 'unverified' ? '; process identity could not be confirmed' : '';
    assert.equal(preflightRefusal({ agent: 'codex-build', projectRunsRoot: root, repoRoot: root }),
      'run B is already active for this repository; two writing runs in one tree are prohibited' + note +
      '\nActive run: ' + directory + '\n' + suffix);
    assert.equal(preflightRefusal({ agent: 'codex-advisor', projectRunsRoot: root, repoRoot: root }), null);
  }
});

test('pending advisor, signed-out and retired-path producers are forwarded unchanged', async () => {
  const root = makeTempTree('passes-forwarding-');
  const resolution = { retired: [{ root: path.join(root, 'old') }], homeRoot: path.join(root, 'new') };
  assert.deepEqual(taskPreflight({ agent: 'codex-advisor', taskText: '', header: {}, resolution }), {
    refusal: 'Options: add a "## Options" section with at least two options.\n' + suffix,
  });
  assert.equal(await codexAvailabilityRefusal({ probe: async () => ({ state: 'available' }) }), null);
  assert.deepEqual(await codexAvailabilityRefusal({
    probe: async () => ({ state: 'logged-out', pathMiss: true, detail: 'Not logged in' }),
  }), {
    unavailable: true,
    text: 'UNAVAILABLE — Codex is not available (signed out); hand the task to the next executor, do not retry\n' +
      'Signal: Not logged in\nOperator check: codex --version; codex login status (sign in with codex login)\n' + suffix,
  });
  const advice = path.join(resolution.retired[0].root, 'B');
  const { retiredPathRefusal } = await import('../src/home/lib/runner/runs-root.mjs');
  const forwarded = retiredPathRefusal(advice, resolution);
  assert.ok(forwarded);
  assert.deepEqual(taskPreflight({ agent: 'codex-build', taskText: '', header: { advice }, resolution }), {
    refusal: forwarded + '\n' + suffix,
  });
  assert.deepEqual(fs.readdirSync(root), [], 'retired evidence must refuse before any file is opened or created');
});

test('pass gates preserve scope and retry refusals, repeated names and successful empty chains', async () => {
  const root = makeTempTree('passes-gates-');
  const input = { projectRunsRoot: root, repoRoot: root, taskText: 'task body', header: {},
    opts: { agent: 'codex-build', phase: 'default', slug: 'task', orderId: 'o', continue: false } };
  const empty = await passGate(input);
  assert.deepEqual(empty.startedChain, []);
  assert.equal(empty.continuationGrant, null);
  assert.equal(empty.advisorTask, null);
  await assert.rejects(passGate({ ...input, opts: { ...input.opts, agent: 'codex-advisor', phase: 'scope', continue: true } }),
    usage(messages[0][2] + ' ' + suffix));
  writeRun(root, { repo: root, slug: 'task', order_id: 'o', state: 'finished', agent: 'codex-advisor', phase: 'scope' },
    { status: 'FAIL', reason: 'capacity' });
  await assert.rejects(passGate({ ...input, opts: { ...input.opts, continue: true },
    header: { grant: { kind: 'retry', run: 'B', reason: 'capacity' } } }), usage(messages[1][2] + ' ' + suffix));
  for (const slug of ['task', 'renamed']) {
    const lead = slug === 'task' ? 'runs for task “task” already exist in this repository' :
      'this task already ran in this repository under the name “task”';
    await assert.rejects(passGate({ ...input, opts: { ...input.opts, slug } }), usage(
      '`continue:` is required: ' + lead + ' (1), latest: ' + path.join(root, 'B') + '. ' +
      'A repeat run is allowed, but the orchestrator decides, not the runner: it read the ' +
      'previous response and knows whether work remains. Add `continue:` if you are finishing ' +
      'the same task; changing `slug:` with the same task text does not stop it being a repeat. ' +
      'Ready grant line: continue: B — capacity. Ready retry line: retry: B — capacity (repeats that pass under order o). ' + suffix));
  }
  assert.equal(preflightRefusal({ agent: 'codex-build', projectRunsRoot: root, repoRoot: root }), null);
  assert.equal(preflightRefusal({ agent: 'codex-advisor', projectRunsRoot: root, repoRoot: root }), null);
});

// Plan_79 D6: deliberate parameter violations stay in a child's private marker, never npm test's journal.
test('issued text composes cleanly while handwritten text and unknown parameters journal violations', () => {
  const root = path.join(makeTempTree('passes-params-'), 'marker');
  const rules = new URL('../src/home/lib/order-rules.mjs', import.meta.url).href;
  const diagnostics = new URL('../src/home/lib/order-diagnostics.mjs', import.meta.url).href;
  const recorder = new URL('../src/home/lib/order-text-record.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { orderRuleMessage } from ${JSON.stringify(rules)};
    import { orderDiagnosticMessage } from ${JSON.stringify(diagnostics)};
    import { checkOutgoingRefusal } from ${JSON.stringify(recorder)};
    const hints = orderRuleMessage('ready-grant-line', { variant: 'none' });
    for (const [key, values, expected] of ${JSON.stringify(messages)}) {
      if (key === 'repeat-task-grant-required') values.hints = hints;
      const text = orderRuleMessage(key, values);
      assert.equal(text, expected);
      checkOutgoingRefusal([text, orderDiagnosticMessage('run-not-created')].join(' '), 'passes-probe');
    }
    const failed = ['agent', 'phase', 'status'].map((violation) =>
      orderRuleMessage('advise-scope-run-required', { violation })).join(', ');
    const text = orderRuleMessage('advise-scope-run-required', { violation: 'meta', failed });
    assert.equal(text, "continued run meta.json failed agent must be 'codex-advisor', phase must be 'scope', status must be 'OK'.");
    checkOutgoingRefusal([text, orderDiagnosticMessage('run-not-created')].join(' '), 'passes-probe');
    for (const [key, values, expected] of ${JSON.stringify(hostMessages)}) {
      const text = orderDiagnosticMessage(key, values);
      assert.equal(text, expected);
      checkOutgoingRefusal([text, orderDiagnosticMessage('run-not-created')].join('\\n'), 'passes-probe');
    }
    orderRuleMessage('repeat-task-grant-required', { ...${JSON.stringify(repeat)}, violation: 'existing', hints: 'handwritten refusal' });
    orderRuleMessage('advise-scope-run-required', { violation: 'meta', failed: 'handwritten metadata' });
    orderRuleMessage('retry-pass-identity', { agent: 'codex-build', phase: 'default', unknown: 'handwritten parameter' });
  `], { env: { ...process.env, CODEX_BRIDGE_TEST_TMP: root }, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const directory = path.join(root, 'order-text-violations');
  const entries = fs.readdirSync(directory).flatMap((file) =>
    fs.readFileSync(path.join(directory, file), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse));
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map(({ kind, key, parameter }) => [kind, key, parameter]), [
    ['parameter', 'repeat-task-grant-required', 'hints'], ['parameter', 'advise-scope-run-required', 'failed'],
    ['parameter', 'retry-pass-identity', 'unknown'],
  ]);
  for (const entry of entries) {
    assert.equal(entry.builder, 'orderRuleMessage');
    assert.notEqual(entry.pid, process.pid);
    assert.match(entry.stack, /checkOrderTextParameters/);
    assert.ok(entry.caller);
  }
});
