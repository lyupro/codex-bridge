/** Plan_67 M7: model refusals precede prompt checks and latch warnings survive later exits. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { modelObservation, recordDispatcherModel } from '../../src/home/lib/dispatcher-model.mjs';
import { readDispatcherPin } from '../../src/home/lib/dispatcher-pin.mjs';
import { orderDiagnosticMessage } from '../../src/home/lib/order-diagnostics.mjs';
import { createStoredRun, decodeDenial, fixture, payload, runGate, validPrompt, writeTaskFile } from './order-gate-fixtures.mjs';

const brandRoot = (root) => path.join(root, '.lyupro', '.codex-bridge');
const stateDir = (root) => path.join(brandRoot(root), 'state');
const VIOLATION_TIME = '2026-10-07T10:00:00.000Z';

async function observe(root, models, hostVersion = '2.1.257', agentType = 'codex-build') {
  await recordDispatcherModel({
    stateDir: stateDir(root),
    observation: modelObservation({ agentType, hostVersion, pin: { family: 'haiku' }, models }),
    now: VIOLATION_TIME,
  });
}

function output(root, input, env) {
  const result = runGate(root, JSON.stringify(input), env);
  assert.equal(result.status, 0, result.stderr);
  if (result.stdout && JSON.parse(result.stdout).hookSpecificOutput) decodeDenial(result.stdout);
  return result.stdout ? JSON.parse(result.stdout) : null;
}

function call(prompt) {
  return JSON.parse(payload('codex-build', prompt));
}

function assertLatch(result) {
  assert.equal(result.systemMessage,
    'codex-bridge: the last codex-build ran on opus, sonnet while the installed contract pins haiku '
    + `(2.1.257, ${VIOLATION_TIME}); the cause is outside this call — another hook or the host; `
    + 'run codex-bridge doctor.');
}

async function installPin(root) {
  const brand = brandRoot(root);
  await fs.mkdir(brand, { recursive: true });
  await fs.writeFile(path.join(brand, '.installed.json'), JSON.stringify({
    format: 2, inventory: 'complete', owners: { fixture: { root } },
  }));
  await fs.mkdir(path.join(root, 'agents', 'codex-bridge'), { recursive: true });
  await fs.writeFile(path.join(root, 'agents', 'codex-bridge', 'codex-build.md'),
    '---\nname: codex-build\nmodel: haiku\n---\nDispatcher fixture.\n');
  const pin = readDispatcherPin({ brandRoot: brand, agentType: 'codex-build' });
  assert.equal(pin.family, 'haiku', JSON.stringify(pin));
}

// OW-077 B1: diagnostic uncertainty may pass, but a broken refusal formatter must escape.
test('diagnostic catches cannot swallow refusal formatter errors', async () => {
  const source = await fs.readFile(new URL('../../src/home/hooks/order-gate.mjs', import.meta.url), 'utf8');
  const definition = source.slice(source.indexOf('const deny ='), source.indexOf('let input;'));
  const failure = new Error('refusal formatter failed');
  const blocks = [
    source.slice(source.indexOf('let problem;'), source.indexOf('try {\n  const latch')),
    source.slice(source.indexOf('let owner;'), source.lastIndexOf('\npass();')),
  ];
  for (const block of blocks) {
    await assert.rejects(vm.runInNewContext(`(async () => { ${definition}\n${block} })()`, {
      withActionRow: () => { throw failure; }, orderDiagnosticMessage,
      checkOutgoingRefusal: () => assert.fail('formatter must run before the outgoing check'),
      systemMessage: undefined, process: { env: {} }, input: {}, agentType: 'codex-build',
      transcriptHostVersion: async () => null, readDispatcherPin: () => ({ family: 'haiku' }),
      BRAND_HOME: { root: 'home' }, envModelProblem: () => 'environment refusal',
      resolveProjectRunsDir: () => ({ dir: 'runs' }), runsRoot: () => 'runs', repository: { repo: 'repo' },
      fs: { readdirSync: () => [] }, path, readStatus: () => null,
      conflictingOrderOwner: () => ({ run: 'owner' }), orderId: 'order', taskHash: 'hash',
      orderOwnerConflictText: () => 'owner refusal',
    }), (error) => error === failure);
  }
});

test('every explicit model value is refused before missing or malformed prompt checks', async (t) => {
  const root = await fixture(t);
  for (const model of ['haiku', 'inherit', '', null, false, 0, {}]) {
    for (const prompt of [undefined, null, {}, 42, '', 'malformed call']) {
      const input = call(prompt);
      input.tool_input.model = model;
      const result = output(root, input);
      assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
      assert.equal(result.hookSpecificOutput.permissionDecisionReason,
        "Order gate denied the Agent call because it passes `model`: a dispatcher's model is set in one place, "
        + 'its installed agent file. Call codex-build without model. '
        + 'The run folder was not created; quota was not spent.\n'
        + orderDiagnosticMessage('next-action', { variant: 'usage' }));
    }
  }
  await assert.rejects(fs.access(path.join(root, 'runs')), { code: 'ENOENT' });
});

test('model policy recognizes registered dispatchers and subagent tools only', async (t) => {
  const root = await fixture(t);
  for (const [type, tool] of [['Explore', 'Agent'], ['codex-build', 'Bash']]) {
    const input = JSON.parse(payload(type, undefined, tool));
    input.tool_input.model = 'opus';
    assert.equal(output(root, input), null);
  }
  const task = await writeTaskFile(root, `order id: model-absent\nscope: src/\nrepository: ${root}`, 'Requested task\n');
  assert.equal(output(root, call(validPrompt(task))), null);
});

test('a header grant and all later pass or deny exits retain the active latch message', async (t) => {
  const root = await fixture(t);
  await observe(root, ['opus', 'sonnet']);
  const repo = path.join(root, 'project');
  await createStoredRun(root, repo, 'prior-owner', {
    order_id: 'latch-grant', task_hash: 'a-different-task', task_hash_scheme: 2,
    slug: 'prior-owner', started_at: VIOLATION_TIME,
  });
  const task = await writeTaskFile(root,
    `order id: latch-grant\nscope: src/\ncontinue: prior-run — finish the remaining tests\nrepository: ${repo}`, 'Requested task\n');
  const grantInput = call(validPrompt(task));
  grantInput.cwd = repo;
  const granted = output(root, grantInput);
  assertLatch(granted);
  assert.equal(granted.hookSpecificOutput, undefined);
  const missingPrompt = output(root, call(undefined));
  assertLatch(missingPrompt);
  assert.equal(missingPrompt.hookSpecificOutput, undefined);
  const missingTask = output(root, call(validPrompt(path.join(root, 'missing.md'))));
  assertLatch(missingTask);
  assert.equal(missingTask.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(missingTask.hookSpecificOutput.permissionDecisionReason, /task file from --task-file could not be read:/);
  const denied = output(root, call('bad prompt'));
  assertLatch(denied);
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  const teammateInput = call(validPrompt(task));
  teammateInput.tool_input.name = 'teammate';
  const teammate = output(root, teammateInput);
  assertLatch(teammate);
  assert.equal(teammate.hookSpecificOutput.permissionDecision, 'deny');
  await writeTaskFile(root, `order id: latch-grant\nscope: src/\nrepository: ${repo}`, 'Requested task\n');
  const collision = output(root, grantInput);
  assertLatch(collision);
  assert.equal(collision.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(collision.hookSpecificOutput.permissionDecisionReason, /prior-owner/);
  await writeTaskFile(root, `order id: latch-no-grant\nscope: src/\nrepository: ${repo}`, 'Requested task\n');
  assertLatch(output(root, call(validPrompt(task))));
  await writeTaskFile(root, 'order id: latch-bad-header', 'Requested task\n');
  const badHeader = output(root, call(validPrompt(task)));
  assertLatch(badHeader);
  assert.equal(badHeader.hookSpecificOutput.permissionDecision, 'deny');
});

test('a later match on another host releases only the matching dispatcher type', async (t) => {
  const root = await fixture(t);
  await observe(root, ['opus', 'sonnet']);
  await observe(root, ['haiku'], '2.1.258', 'codex-review');
  assertLatch(output(root, call(undefined)));
  await observe(root, ['inherit'], '2.1.259');
  assertLatch(output(root, call(undefined)));
  await observe(root, ['haiku'], '2.1.260');
  assert.equal(output(root, call(undefined)), null);
  const denied = output(root, call('bad prompt'));
  assert.equal(denied.systemMessage, undefined);
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
});

test('latch warning preserves dispatcher data and the unknown host version fallback', async (t) => {
  const root = await fixture(t);
  await observe(root, ['opus', 'sonnet'], null, 'codex-review');
  const result = output(root, JSON.parse(payload('codex-review', undefined)));
  assert.equal(result.systemMessage,
    'codex-bridge: the last codex-review ran on opus, sonnet while the installed contract pins haiku '
    + `(unknown, ${VIOLATION_TIME}); the cause is outside this call — another hook or the host; `
    + 'run codex-bridge doctor.');
  assert.equal(result.hookSpecificOutput, undefined);
});

// Plan_79 B5b2c/D5: exercise both real output functions in one isolated child journal.
test('handwritten systemMessage journals its outgoing transport on pass and deny', async (t) => {
  const root = await fixture(t);
  const marker = path.join(root, 'marker');
  const gate = new URL('../../src/home/hooks/order-gate.mjs', import.meta.url).href;
  const lib = new URL('../../src/home/lib/', import.meta.url);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import vm from 'node:vm';
    import { checkOutgoingRefusal } from ${JSON.stringify(new URL('order-text-record.mjs', lib).href)};
    import { orderDiagnosticMessage } from ${JSON.stringify(new URL('order-diagnostics.mjs', lib).href)};
    import { withActionRow } from ${JSON.stringify(new URL('runner/args.mjs', lib).href)};
    const source = fs.readFileSync(new URL(${JSON.stringify(gate)}), 'utf8');
    const definition = source.slice(source.indexOf('const pass ='), source.indexOf('let input;'));
    const reason = orderDiagnosticMessage('run-not-created');
    for (const transport of ['pass', 'deny']) {
      let written;
      let status;
      const emit = vm.runInNewContext(definition + transport + ';', {
        systemMessage: 'handwritten system message', checkOutgoingRefusal, withActionRow, orderDiagnosticMessage,
        process: { stdout: { write: (text) => { written = text; } }, exit: (code) => { status = code; } },
      }, { filename: ${JSON.stringify(gate)} });
      emit(reason, { action: 'usage' });
      assert.equal(status, 0);
      assert.equal(written, JSON.stringify({
        systemMessage: 'handwritten system message',
        ...(transport === 'deny' ? { hookSpecificOutput: {
          hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: withActionRow(reason, 'usage'),
        } } : {}),
      }));
    }
  `], { env: { ...process.env, CODEX_BRIDGE_TEST_TMP: marker }, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const directory = path.join(marker, 'order-text-violations');
  const entries = (await Promise.all((await fs.readdir(directory)).map(async (file) =>
    (await fs.readFile(path.join(directory, file), 'utf8')).split(/\r?\n/).filter(Boolean).map(JSON.parse)))).flat();
  assert.equal(entries.length, 2);
  for (const entry of entries) {
    assert.equal(entry.kind, 'outgoing');
    assert.equal(entry.transport, 'system-message');
    assert.equal(entry.message, 'handwritten system message');
    assert.notEqual(entry.pid, process.pid);
    assert.match(entry.stack, /checkOutgoingRefusal/);
  }
});

test('missing and corrupt ledgers do not produce warnings or block passes', async (t) => {
  const root = await fixture(t);
  assert.equal(output(root, call(undefined)), null);
  await fs.mkdir(stateDir(root), { recursive: true });
  for (const data of ['{', JSON.stringify({ entries: { broken: null } })]) {
    await fs.writeFile(path.join(stateDir(root), 'dispatcher-model.json'), data);
    assert.equal(output(root, call(undefined)), null);
    assert.equal(output(root, call('bad prompt')).systemMessage, undefined);
  }
});

test('env refusal requires an overriding known host and a foreign parsed family', async (t) => {
  const root = await fixture(t);
  await installPin(root);
  const task = await writeTaskFile(root,
    `order id: env-grant\nscope: src/\ncontinue: prior-run — finish the remaining tests\nrepository: ${root}`, 'Requested task\n');
  const transcript = path.join(root, 'host.jsonl');
  const env = { CLAUDE_CODE_SUBAGENT_MODEL: 'opus', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' };
  for (const [version, force, denied] of [
    ['2.1.250', '', true], ['2.1.251', '', false], ['2.1.256', '1', false],
    ['2.1.257', '1', true], ['2.1.257', '0', false], [null, '1', false],
  ]) {
    await fs.writeFile(transcript, JSON.stringify(version ? { version } : { type: 'user' }) + '\n');
    for (const prompt of [validPrompt(task), undefined]) {
      const input = call(prompt);
      input.transcript_path = transcript;
      const result = output(root, input, { ...env, CLAUDE_CODE_SUBAGENT_MODEL_FORCE: force });
      if (denied) {
        assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
        assert.match(result.hookSpecificOutput.permissionDecisionReason, /CLAUDE_CODE_SUBAGENT_MODEL="opus"/);
        assert.ok(result.hookSpecificOutput.permissionDecisionReason.includes(`host ${version}`));
        assert.match(result.hookSpecificOutput.permissionDecisionReason, /pinned family haiku/);
      } else {
        assert.equal(result, null);
      }
    }
  }
  await fs.writeFile(transcript, JSON.stringify({ version: '2.1.257' }) + '\n');
  const input = call(validPrompt(task));
  input.transcript_path = transcript;
  for (const model of ['haiku', 'claude-haiku-4-5', 'inherit', '123']) {
    assert.equal(output(root, input, { ...env, CLAUDE_CODE_SUBAGENT_MODEL: model }), null);
  }
  input.transcript_path = path.join(root, 'missing-host.jsonl');
  assert.equal(output(root, input, env), null);
  await assert.rejects(fs.access(path.join(root, 'runs')), { code: 'ENOENT' });
});
