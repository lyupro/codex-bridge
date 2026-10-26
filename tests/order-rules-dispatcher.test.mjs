/** Plan_79 B5a D3-D6: call producers and transports preserve bytes without laundering refusal text. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ORDER_RULES, orderRuleMessage } from '../src/home/lib/order-rules.mjs';
import { ORDER_DIAGNOSTICS, orderDiagnosticMessage } from '../src/home/lib/order-diagnostics.mjs';
import { RULES as CALL_RULES } from '../src/home/lib/order-rules/call.mjs';
import { DIAGNOSTICS as HOST_DIAGNOSTICS } from '../src/home/lib/order-diagnostics/host-state.mjs';
import { DIAGNOSTICS as INTERNAL_DIAGNOSTICS } from '../src/home/lib/order-diagnostics/internal.mjs';
import { parseDispatcherCall, renderCallRefusal, renderRequiredInputSummary, TASK_FILE_INPUT } from '../src/home/lib/dispatcher-call.mjs';
import { canonicalRunCommand, renderRunCommandTemplate } from '../src/home/lib/dispatcher-command.mjs';
import { envModelProblem } from '../src/home/lib/subagent-model-env.mjs';
import { claudePaths } from '../src/home/lib/claude-layout.mjs';
import { CLI_NAMES } from '../src/home/lib/cli-names.mjs';
import { homeArtifact } from '../src/home/lib/home-registry.mjs';
import { readOwnerRoots } from '../src/home/lib/install-owner-roots.mjs';
import { readDispatcherPin } from '../src/home/lib/dispatcher-pin.mjs';
import { modelObservation, observeDispatcherModelStop } from '../src/home/lib/dispatcher-model.mjs';
import { dispatcherStatePath, readDispatcherState, updateDispatcherState } from '../src/home/lib/dispatcher-state.mjs';
import { checkOutgoingRefusal } from '../src/home/lib/order-text-record.mjs';
import { ADMISSION_FILES } from './order-guard/admission-files.mjs';
import { checkRefusalSites } from './order-guard/refusal-checker.mjs';
import { makeTempTree } from './temp-tree.mjs';
import { runGate, payload } from './hooks/order-gate-fixtures.mjs';

const shapeCases = [
  [{ violation: 'free-text' }, 'not a `label: value` line; free text belongs in the task file'],
  [{ violation: 'empty', label: 'task file' }, 'label `task file` has an empty value'],
  [{ violation: 'duplicate', label: 'task file', first: 2, line: 3 },
    'label `task file` is given twice (line 2 and line 3)'],
  [{ violation: 'spelling', label: 'task file' }, 'write the label exactly as `task file:`'],
  [{ violation: 'header', label: 'scope new' },
    'label `scope new` moved to the task-file header; the call is only `task file: <absolute path>`'],
  [{ violation: 'missing', label: 'task file' }, 'missing required label `task file`'],
  [{ violation: 'placeholder', label: 'task file' }, 'label `task file` is still a placeholder'],
  [{ violation: 'absolute' }, 'label `task file` must be an absolute path'],
  [{ violation: 'unsafe', label: 'task file', sequence: '"' },
    'label `task file` contains "\\\""; put free text in the task file'],
  [{ violation: 'rewritten', label: 'task file', sequence: '$' },
    'label `task file` contains "$", which the shell rewrites inside double quotes; ' +
      'write the path with forward slashes and without `$`'],
];

for (const [values, expected] of shapeCases) {
  test(`call shape preserves ${values.violation}`, () => {
    const text = orderRuleMessage('dispatcher-call-shape', values);
    assert.equal(text, expected);
    assert.equal(checkOutgoingRefusal(text, 'case'), expected);
  });
}

test('model and teammate call rules preserve the hook messages and reuse the run-state tail', () => {
  const text = [orderRuleMessage('agent-call-model', { agentType: 'codex-build' }),
    orderDiagnosticMessage('run-not-created')].join(' ');
  assert.equal(text,
    "Order gate denied the Agent call because it passes `model`: a dispatcher's model is set in one place, " +
    'its installed agent file. Call codex-build without model. The run folder was not created; quota was not spent.');
  assert.equal(checkOutgoingRefusal(text, 'case'), text);
  for (const field of ['name', 'team_name']) {
    const reason = orderRuleMessage('agent-call-teammate', { field, agentType: 'codex-scout' });
    assert.equal(reason,
      `Order gate denied the Agent call because it passes \`${field}\`: a dispatcher launched as a ` +
      'teammate escapes the dispatcher gate, whose agent_type becomes the teammate name. Call ' +
      'codex-scout with subagent_type only, without name or team_name.');
    assert.equal(checkOutgoingRefusal(reason, 'case'), reason);
  }
});

test('host environment producer preserves the quoted model, pin, version and success null', () => {
  const env = { CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' };
  const text = envModelProblem({ env, hostVersion: '2.1.257', pinFamily: 'opus' });
  assert.equal(text,
    'Order gate denied the Agent call because CLAUDE_CODE_SUBAGENT_MODEL="sonnet" ' +
    'overrides the installed dispatcher pin opus on host 2.1.257. ' +
    'This hook reads the environment of the running Claude Code session and cannot tell where the value was set. ' +
    'A running session may keep a key that was removed from settings.json env after it started. ' +
    'Remove CLAUDE_CODE_SUBAGENT_MODEL, or set it to the pinned family opus, wherever it is still set, then fully exit and restart each affected Claude Code session; unsetting it in a hook, subagent or shell command does not reach the session. ' +
    'If it returns after a restart, look in the settings env blocks, the terminal or IDE that launched Claude Code, and the operating-system environment. ' +
    'The run folder was not created; quota was not spent.');
  assert.equal(checkOutgoingRefusal(text, 'case'), text);
  assert.equal(envModelProblem({ env, hostVersion: '2.1.257', pinFamily: 'sonnet' }), null);
  assert.equal(envModelProblem({ env, hostVersion: null, pinFamily: 'opus' }), null);
});

test('call refusal preserves all lines including the missing-path help and header template', () => {
  const text = renderCallRefusal('codex-scout', parseDispatcherCall('codex-scout', 'task file:').problems);
  assert.equal(text, [
    'Order gate denied the Agent call: the call text must be only `label: value` lines.',
    '- line 1: `task file:` — label `task file` has an empty value',
    '- missing required label `task file` — Absolute path to a file holding the task statement verbatim, written by the orchestrator with its file tool. The dispatcher passes the path to the runner and never creates, reads or rewrites the file: writing it from the shell reintroduces the permission prompt this file channel exists to remove. Given no path, return the refusal. Example: `task file: C:/Users/me/AppData/Local/Temp/claude/<session>/scratchpad/task-plan-13.md`.',
    'The call is only `task file: <absolute path>`.',
    'The order goes in the header at the top of that file:',
    'order id: plan-13-scout-20260804',
    'continue: 2026-08-05_092913_plan14-build — LIMIT at step 3, tests unwritten',
    'retry: 2026-10-03_172017_cc-d66-advisor — model at capacity, same pass again',
    'resume: 2026-10-16_140740_ow066-b2-resume-grant — advise stalled after reading, continue its thread',
    'repository: C:/work/codex-bridge',
    'slug: plan-76-parser',
    'effort: high',
    'Free text belongs in the task file.',
  ].join('\n'));
  assert.equal(checkOutgoingRefusal(text, 'case'), text);
  assert.equal(TASK_FILE_INPUT.explanation, orderRuleMessage('dispatcher-task-file-help'));
});

test('summary keeps its bytes and the unknown-agent empty string', () => {
  assert.equal(renderRequiredInputSummary('codex-scout'),
    'The call is only `task file` (an absolute path). The task-file header requires `order id`; ' +
    'conditional labels: `continue` (when this pass continues or repeats a named run), ' +
    '`retry` (when this pass continues or repeats a named run), ' +
    '`resume` (when this pass continues or repeats a named run); optional labels: `repository`, `slug`, `effort`. ' +
    'Free text belongs in the task file.');
  assert.equal(renderRequiredInputSummary('unknown-agent'), '');
});

test('command refusals keep their frame, reason order, quoting and success object', () => {
  assert.deepEqual(canonicalRunCommand(undefined, ''), { refusal: 'Refused: unknown dispatcher agent undefined.' });
  assert.deepEqual(canonicalRunCommand('codex-scout', null), { refusal: 'Refused: prompt text is missing or is not text.' });
  assert.deepEqual(canonicalRunCommand('codex-scout', 'Please inspect the repository.'), {
    refusal: 'Refused: the call text must be only label: value lines: ' +
      'line 1: not a `label: value` line; free text belongs in the task file; missing required label `task file`.',
  });
  assert.deepEqual(canonicalRunCommand('codex-scout', 'task file: C:/scratch/task.md'), {
    command: 'codex-bridge run --agent codex-scout --task-file "C:/scratch/task.md"',
  });
  assert.throws(() => renderRunCommandTemplate(null), { message: 'unknown dispatcher agent null' });
});

test('hook deny preserves its JSON bytes and exit code', () => {
  const root = makeTempTree('order-rules-dispatcher-hook-');
  const input = JSON.parse(payload('codex-build', ''));
  input.tool_input.model = 'opus';
  const result = runGate(root, JSON.stringify(input));
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'deny',
    permissionDecisionReason:
      "Order gate denied the Agent call because it passes `model`: a dispatcher's model is set in one place, " +
      'its installed agent file. Call codex-build without model. The run folder was not created; quota was not spent.\n' +
      orderDiagnosticMessage('next-action', { variant: 'usage' }),
  } }));
});

test('new entries belong to their call, host and internal owners with frozen data lists', () => {
  for (const key of ['agent-call-model', 'agent-call-teammate', 'dispatcher-call-shape',
    'dispatcher-task-file-help', 'dispatcher-call-refusal', 'dispatcher-call-summary']) {
    assert.equal(ORDER_RULES[key], CALL_RULES[key]);
    assert.equal(ORDER_RULES[key].topic, 'order');
    assert.ok(Object.isFrozen(ORDER_RULES[key].data));
  }
  assert.equal(ORDER_DIAGNOSTICS['subagent-model-env-pin'], HOST_DIAGNOSTICS['subagent-model-env-pin']);
  assert.equal(ORDER_DIAGNOSTICS['subagent-model-env-pin'].category, 'host-state');
  for (const key of ['dispatcher-agent-input-known', 'dispatcher-prompt-text-required', 'dispatcher-refusal']) {
    assert.equal(ORDER_DIAGNOSTICS[key], INTERNAL_DIAGNOSTICS[key]);
    assert.equal(ORDER_DIAGNOSTICS[key].category, 'internal');
  }
});

test('unknown call selectors fail loud', () => {
  for (const [key, values, message] of [
    ['dispatcher-call-shape', { violation: 'unknown' }, 'unknown dispatcher-call-shape violation: unknown'],
    ['dispatcher-call-refusal', { part: 'unknown' }, 'unknown dispatcher-call-refusal part: unknown'],
    ['dispatcher-call-summary', { variant: 'unknown' }, 'unknown dispatcher-call-summary variant: unknown'],
  ]) assert.throws(() => orderRuleMessage(key, values), { message });
});

// The guard reads versionParts(value) as a refusal wrapper, so the two host version boundaries it compares
// carry the reviewed opt-out; any other opt-out in these files is a regression.
const EXPECTED_OPT_OUTS = {
  'src/home/lib/subagent-model-env.mjs': [10, 11].map((line) => 'src/home/lib/subagent-model-env.mjs:' + line
    + ': // order-guard: not-a-refusal — host version boundary compared as data'),
};

test('all four producers are admitted without pending migration or unreviewed opt-outs', () => {
  for (const file of ['src/home/hooks/order-gate.mjs', 'src/home/lib/dispatcher-call.mjs',
    'src/home/lib/dispatcher-command.mjs', 'src/home/lib/subagent-model-env.mjs']) {
    assert.ok(ADMISSION_FILES.includes(file));
    const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.deepEqual(checkRefusalSites(source, file), { violations: [], optOuts: EXPECTED_OPT_OUTS[file] ?? [] });
    assert.doesNotMatch(source, /recordOrderText\(/);
  }
});

// Plan_79 D5/D6: deliberate violations get separate child-process journals, never the suite's journal.
function runProbe(body) {
  const root = path.join(makeTempTree('order-rules-dispatcher-probe-'), 'marker');
  const lib = new URL('../src/home/lib/', import.meta.url);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import vm from 'node:vm';
    import { orderRuleMessage } from ${JSON.stringify(new URL('order-rules.mjs', lib).href)};
    import { checkOutgoingRefusal } from ${JSON.stringify(new URL('order-text-record.mjs', lib).href)};
    ${body}
  `], { env: { ...process.env, CODEX_BRIDGE_TEST_TMP: root }, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const directory = path.join(root, 'order-text-violations');
  return fs.existsSync(directory) ? fs.readdirSync(directory).flatMap((file) =>
    fs.readFileSync(path.join(directory, file), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse)) : [];
}

test('handwritten call reason journals a parameter violation before the output is recorded', () => {
  const entries = runProbe(`
    const text = orderRuleMessage('dispatcher-call-refusal', { part: 'command', reasons: 'handwritten reason' });
    assert.equal(text, 'the call text must be only label: value lines: handwritten reason');
    assert.equal(checkOutgoingRefusal(text, 'case'), text);
  `);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'parameter');
  assert.equal(entries[0].key, 'dispatcher-call-refusal');
  assert.equal(entries[0].parameter, 'reasons');
  assert.equal(entries[0].message, 'handwritten reason');
  assert.notEqual(entries[0].pid, process.pid);
});

test('handwritten text sent through the hook deny journals its outgoing transport', () => {
  const gate = new URL('../src/home/hooks/order-gate.mjs', import.meta.url).href;
  const args = new URL('../src/home/lib/runner/args.mjs', import.meta.url).href;
  const diagnostics = new URL('../src/home/lib/order-diagnostics.mjs', import.meta.url).href;
  const entries = runProbe(`
    import { withActionRow } from ${JSON.stringify(args)};
    import { orderDiagnosticMessage } from ${JSON.stringify(diagnostics)};
    const source = fs.readFileSync(new URL(${JSON.stringify(gate)}), 'utf8');
    const definition = source.slice(source.indexOf('const deny ='), source.indexOf('let input;'));
    let written;
    let status;
    const deny = vm.runInNewContext(definition + 'deny;', {
      systemMessage: undefined, checkOutgoingRefusal, withActionRow, orderDiagnosticMessage,
      process: { stdout: { write: (text) => { written = text; } }, exit: (code) => { status = code; } },
    }, { filename: ${JSON.stringify(gate)} });
    deny('handwritten outgoing', { action: 'usage' });
    assert.equal(status, 0);
    assert.equal(JSON.parse(written).hookSpecificOutput.permissionDecisionReason,
      'handwritten outgoing\\n' + orderDiagnosticMessage('next-action', { variant: 'usage' }));
    assert.throws(() => deny('x'), { message: orderDiagnosticMessage('next-action-variant-required') });
    for (const how of [null, 'usage', {}]) {
      assert.throws(() => deny('x', how), { message: orderDiagnosticMessage('next-action-variant-required') });
    }
  `);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'outgoing');
  assert.equal(entries[0].transport, 'deny');
  assert.equal(entries[0].message, 'handwritten outgoing\n' + orderDiagnosticMessage('next-action', { variant: 'usage' }));
  assert.notEqual(entries[0].pid, process.pid);
  assert.match(entries[0].stack, /checkOutgoingRefusal/);
});

// Plan_79 B5b2a / D8 / B4g: migrate the owner-record producer with its pin forwarder; order produces no text.
for (const [name, category, keys] of [
  ['dispatcher-order', null, []],
  ['dispatcher-pin', 'host-state', ['dispatcher-pin-file-readable', 'dispatcher-pin-frontmatter-readable',
    'dispatcher-pin-agent-name', 'dispatcher-pin-model-family', 'dispatcher-pin-owner-agreement']],
  ['dispatcher-model', 'host-state', ['dispatcher-model-observation', 'dispatcher-model-stop-warning']],
  ['dispatcher-state', 'internal', ['dispatcher-state-identity-required', 'dispatcher-state-mutator-required',
    'dispatcher-state-record-required']],
  ['install-owner-roots', 'host-state', ['install-record-owners-readable']],
]) {
  test(`${name} is admitted, not pending, and owns no diagnostic text outside the registry`, () => {
    const file = `src/home/lib/${name}.mjs`;
    assert.ok(ADMISSION_FILES.includes(file));
    const source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.deepEqual(checkRefusalSites(source, file), { violations: [], optOuts: [] });
    assert.doesNotMatch(source, /recordOrderText\(|new TypeError\(['"`]/);
    assert.deepEqual([...source.matchAll(/orderDiagnosticMessage\('([^']+)'/g)].map(match => match[1]).sort(), keys.toSorted());
    for (const key of keys) {
      assert.equal(ORDER_DIAGNOSTICS[key].category, category);
      assert.equal(ORDER_DIAGNOSTICS[key], (category === 'host-state' ? HOST_DIAGNOSTICS : INTERNAL_DIAGNOSTICS)[key]);
      assert.ok(Object.isFrozen(ORDER_DIAGNOSTICS[key].data));
    }
  });
}

function pinFixture(contents) {
  const tree = makeTempTree('order-rules-dispatcher-pin-');
  const brandRoot = path.join(tree, 'brand');
  fs.mkdirSync(brandRoot);
  const owners = {};
  const files = contents.map((content, index) => {
    const root = path.join(tree, `host ${index}`, '.claude');
    owners[index] = { root };
    const file = path.join(claudePaths(root).agentsDir, 'codex-build.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (content === false) fs.mkdirSync(file);
    else if (content !== null) fs.writeFileSync(file, content);
    return { root, file };
  });
  fs.writeFileSync(path.join(brandRoot, homeArtifact('install-record').primary[0]),
    JSON.stringify({ format: 2, inventory: 'complete', owners }));
  return { tree, brandRoot, files };
}

test('pin diagnostics preserve every repair sentence byte for byte and register each reason', () => {
  const agentType = 'codex-build';
  for (const [content, expected] of [
    [null, (file, root) => `Dispatcher file "${file}" is missing; repair with ${CLI_NAMES[0]} install --host "${root}".`],
    [false, (file, root) => `Dispatcher file "${file}" cannot be read; repair with ${CLI_NAMES[0]} install --host "${root}".`],
    ['No frontmatter.', file => `The frontmatter in "${file}" is unreadable.`],
    ['---\nname: other\nmodel: haiku\n---\n', file => `Dispatcher file "${file}" does not declare the required frontmatter name "${agentType}".`],
    [`---\nname: ${agentType}\nmodel: inherit\n---\n`, file => `Dispatcher file "${file}" has no parseable model family in its frontmatter model.`],
  ]) {
    const { brandRoot, files: [{ file, root }] } = pinFixture([content]);
    const reason = expected(file, root);
    assert.deepEqual(readDispatcherPin({ brandRoot, agentType }), { family: null, reasons: [reason] });
    assert.equal(checkOutgoingRefusal(reason, 'case'), reason);
  }
  const { brandRoot, files } = pinFixture(['haiku', 'sonnet'].map(model => `---\nname: ${agentType}\nmodel: ${model}\n---\n`));
  const disagreement = files.map(({ root }, index) => `"${root}" -> ${['haiku', 'sonnet'][index]}`).join(', ');
  const reason = `Installed dispatcher model families disagree across owners: ${disagreement}.`;
  assert.deepEqual(readDispatcherPin({ brandRoot, agentType }), { family: null, reasons: [reason] });
  assert.equal(checkOutgoingRefusal(reason, 'case'), reason);
});

test('pin owner-record reasons preserve the read-only producer bytes without laundering prose', () => {
  const owners = { owner: { root: 'C:/fixture/host/.claude' } };
  for (const [record, suffix, problem] of [
    [undefined, 'is missing.', 'missing'], [false, 'cannot be read.', 'unreadable'], ['{invalid', 'contains invalid JSON.', 'unreadable'],
    [{ format: 1 }, 'is not format 2.', 'not-format-2'], [{ format: 2, owners: {} }, 'has no owners.', 'no-owners'],
    [{ format: 2, inventory: 'incomplete', owners },
      `has an incomplete inventory; if the recorded hosts are all the hosts using this home, run ${CLI_NAMES[0]} inventory confirm.`, 'inventory-incomplete'],
    [{ format: 2, inventory: 'complete', owners, legacy: {} }, 'contains a legacy partition.', 'legacy-partition'],
    [{ format: 2, inventory: 'complete', owners: { owner: { root: '' } } }, 'has an owner without a non-empty root.', 'malformed-owner'],
  ]) {
    const brandRoot = makeTempTree('order-rules-dispatcher-owner-record-');
    const file = path.join(brandRoot, homeArtifact('install-record').primary[0]);
    if (record === false) fs.mkdirSync(file);
    else if (record !== undefined) fs.writeFileSync(file, typeof record === 'string' ? record : JSON.stringify(record));
    const expected = `Installation record at ${file} ${suffix}`;
    const resultOwners = readOwnerRoots({ brandRoot });
    assert.deepEqual(resultOwners, { problem, detail: expected });
    assert.equal(checkOutgoingRefusal(resultOwners.detail, 'case'), expected);
    const result = readDispatcherPin({ brandRoot, agentType: 'codex-build' });
    assert.deepEqual(result, { family: null, reasons: [expected] });
    assert.equal(checkOutgoingRefusal(result.reasons[0], 'case'), expected);
  }
});

test('model diagnostic variants preserve detail bytes and all non-text observation fields', async () => {
  for (const [models, complete, verdict, detail] of [
    [['sonnet', 'opus'], true, 'violation', 'codex-build ran on sonnet, opus while the installed contract pins haiku'],
    [['haiku'], true, 'match', 'codex-build ran on haiku matching the installed contract pin haiku'],
    [['haiku'], false, 'undetermined', 'codex-build model comparison is undetermined: the transcript has unreadable records'],
    [[], true, 'undetermined', 'codex-build model comparison against the installed contract is undetermined'],
  ]) {
    const observation = modelObservation({ agentType: 'codex-build', hostVersion: 'host-a', pin: { family: 'haiku' }, models, complete });
    assert.deepEqual(observation, { key: 'host-a|codex-build', verdict, detail, data: {
      hostVersion: 'host-a', agentType: 'codex-build', pinFamily: 'haiku', parsed: models, unparsed: 0,
      comparison: 'installed-contract', ...(!complete ? { complete: false } : {}),
    } });
    assert.equal(checkOutgoingRefusal(detail, 'case'), detail);
  }
  const { tree, brandRoot } = pinFixture(['---\nname: codex-build\nmodel: haiku\n---\n']);
  const transcript = path.join(tree, 'agent.jsonl');
  const input = { agent_type: 'codex-build', agent_transcript_path: transcript };
  for (const model of ['sonnet', 'haiku']) {
    fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { model } }));
    const warning = await observeDispatcherModelStop({ brandRoot, stateDir: path.join(brandRoot, 'state'), input, hostVersion: 'host-a' });
    assert.equal(warning, model === 'sonnet'
      ? 'codex-bridge: dispatcher codex-build ran on sonnet while the installed contract pins haiku — Claude quota was spent on it; run codex-bridge doctor.'
      : null);
    if (warning) assert.equal(checkOutgoingRefusal(warning, 'case'), warning);
  }
});

test('state diagnostics preserve TypeError messages and leave system errors untouched', async () => {
  const ids = { stateDir: path.join(makeTempTree('order-rules-dispatcher-state-'), 'state'), sessionId: 'session', agentId: 'agent' };
  for (const invalid of [{ sessionId: '' }, { agentId: null }]) {
    assert.throws(() => dispatcherStatePath({ ...ids, ...invalid }), { name: 'TypeError', message: 'sessionId and agentId must be non-empty strings' });
  }
  await assert.rejects(updateDispatcherState(ids, null), { name: 'TypeError', message: 'mutate must be a function' });
  for (const record of [null, [], 'text']) {
    await assert.rejects(updateDispatcherState(ids, () => record), { name: 'TypeError', message: 'mutate must produce a JSON record object' });
  }
  for (const key of ['dispatcher-state-identity-required', 'dispatcher-state-mutator-required', 'dispatcher-state-record-required']) {
    const text = orderDiagnosticMessage(key);
    assert.equal(checkOutgoingRefusal(text, 'case'), text);
  }
  const file = dispatcherStatePath(ids);
  fs.mkdirSync(file);
  let systemError;
  try { fs.readFileSync(file, 'utf8'); } catch (error) { systemError = error; }
  assert.ok(systemError);
  assert.throws(() => readDispatcherState(ids), { code: systemError.code, message: systemError.message });
});

test('unknown pin and model diagnostic selectors fail loud', () => {
  assert.throws(() => orderDiagnosticMessage('dispatcher-pin-file-readable', { problem: 'unknown' }),
    { message: 'unknown dispatcher-pin-file-readable problem: unknown' });
  assert.throws(() => orderDiagnosticMessage('dispatcher-model-observation', { verdict: 'unknown' }),
    { message: 'unknown dispatcher-model-observation verdict: unknown' });
  assert.throws(() => orderDiagnosticMessage('install-record-owners-readable', { problem: 'unknown' }),
    { message: 'unknown dispatcher-pin-owner-record problem: unknown' });
  assert.equal(ORDER_DIAGNOSTICS['install-record-owners-problem-known'],
    INTERNAL_DIAGNOSTICS['install-record-owners-problem-known']);
  assert.equal(ORDER_DIAGNOSTICS['install-record-owners-problem-known'].category, 'internal');
});
