/** Plan_79 D8: dispatcher corrections and the installed prompt share checked, owned sentences. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  DISPATCHER_PROTOCOL, dispatcherProtocolMessage, renderDispatcherProtocol,
} from '../src/home/lib/dispatcher-protocol.mjs';
import { decidePreToolUse, HANDBACK_TOOL } from '../src/home/lib/dispatcher-gate.mjs';
import { canonicalRunCommand } from '../src/home/lib/dispatcher-command.mjs';
import { ORDER_AGENTS } from '../src/home/lib/order-schema.mjs';
import { ORDER_DIAGNOSTICS, orderDiagnosticMessage } from '../src/home/lib/order-diagnostics.mjs';
import { makeTempTree } from './temp-tree.mjs';

const lib = new URL('../src/home/lib/', import.meta.url);
const hook = new URL('../src/home/hooks/dispatcher-gate.mjs', import.meta.url);
const prefix = 'codex-bridge dispatcher gate: ';
const keys = [
  'handback-delivered', 'order-unreadable', 'canonical-foreground', 'verdict-pending',
  'runner-verdict-required', 'canonical-before-handback', 'command-repeat',
  'denial',
];
const sentenceKeys = keys.filter((key) => key !== 'denial');

test('the obligation catalog is frozen, keyed and declares every data list', () => {
  assert.ok(Object.isFrozen(DISPATCHER_PROTOCOL));
  assert.deepEqual(Object.keys(DISPATCHER_PROTOCOL), keys);
  for (const [key, entry] of Object.entries(DISPATCHER_PROTOCOL)) {
    assert.ok(Object.isFrozen(entry));
    assert.ok(Object.isFrozen(entry.data));
    assert.deepEqual(entry.data, key === 'denial' ? ['command'] : []);
    assert.deepEqual(Object.keys(entry).sort(), ['data', 'message']);
  }
});

for (const agent of ORDER_AGENTS) {
  test(`${agent}: every possible deny sentence is verbatim in the prompt and every entry is used`, () => {
    const command = canonicalRunCommand(agent, 'task file: C:/scratch/task.md').command;
    const order = { command };
    const unreadable = { refusal: orderDiagnosticMessage('dispatcher-prompt-text-required') };
    const cases = [
      [{ tool_name: 'Bash', tool_input: { command } }, order, { handback: 'delivered' }],
      [{ tool_name: HANDBACK_TOOL }, unreadable, { handback: 'delivered' }],
      [{ tool_name: 'Write' }, order, { handback: 'delivered' }],
      [{ tool_name: 'Bash' }, unreadable, {}],
      [{ tool_name: 'Write' }, unreadable, {}],
      [{ tool_name: 'Bash', tool_input: { command, run_in_background: true } }, order, {}],
      [{ tool_name: 'Bash', tool_input: { command: 'different command' } }, order, {}],
      [{ tool_name: HANDBACK_TOOL }, order, { runnerOutput: 'STARTED run', runnerFinal: false }],
      [{ tool_name: HANDBACK_TOOL }, order, {}],
      [{ tool_name: 'Write' }, order, {}],
    ];
    const protocol = renderDispatcherProtocol(agent);
    const used = new Set();
    for (const [payload, currentOrder, state] of cases) {
      const decision = decidePreToolUse({ payload, order: currentOrder, state });
      assert.equal(decision.kind, 'deny');
      assert.ok(decision.reason.startsWith(prefix));
      used.add('denial');
      const lines = decision.reason.slice(prefix.length).split('\n');
      for (const sentence of lines.filter((line) => line !== command)) {
        assert.ok(protocol.includes(sentence), `${agent}: ${sentence}`);
        const key = sentenceKeys.find((key) => dispatcherProtocolMessage(key) === sentence);
        assert.ok(key, `deny sentence outside the catalog: ${sentence}`);
        used.add(key);
      }
    }
    assert.deepEqual([...used].sort(), [...keys].sort(), 'no orphan or unexercised catalog entry');
    for (const key of sentenceKeys) {
      const sentence = dispatcherProtocolMessage(key);
      const lines = protocol.split('\n');
      const index = lines.indexOf(`- ${sentence}`);
      assert.ok(index > 0, `${key}: quoted instruction is a list item`);
      let lead = index - 1;
      while (lead >= 0 && (!lines[lead].trim() || lines[lead].startsWith('- '))) lead--;
      assert.ok(lines[lead]?.endsWith(':'), `${key}: instruction lead-in ends with a colon`);
    }
  });
}

test('unknown and inherited protocol keys throw', () => {
  for (const key of ['missing', 'toString', 'constructor', '__proto__', undefined]) {
    assert.throws(() => dispatcherProtocolMessage(key), {
      message: `unknown dispatcher protocol key: ${key}`,
    });
  }
});

test('handback failures own run-state diagnostics and only their data is unchecked', () => {
  for (const key of [
    'dispatcher-order-transcript-readable', 'dispatcher-order-refusal',
    'dispatcher-receipt-conflict', 'dispatcher-did-not-delegate',
    'dispatcher-runner-output',
  ]) assert.equal(ORDER_DIAGNOSTICS[key].category, 'run-state');
  assert.deepEqual(ORDER_DIAGNOSTICS['dispatcher-order-refusal'].data, []);
  assert.deepEqual(ORDER_DIAGNOSTICS['dispatcher-receipt-conflict'].data, ['runReceipt', 'runReceiptConflict']);
  assert.deepEqual(ORDER_DIAGNOSTICS['dispatcher-did-not-delegate'].data, ['command']);
  assert.deepEqual(ORDER_DIAGNOSTICS['dispatcher-runner-output'].data, ['output']);
  assert.equal(ORDER_DIAGNOSTICS['dispatcher-gate-internal-error'].category, 'internal');
});

// D5/D6: deliberate violations live in a child's marker, never in npm test's journal.
function probe(body) {
  const root = makeTempTree('dispatcher-protocol-catalog-');
  const marker = path.join(root, 'marker');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    import { dispatcherProtocolMessage, dispatcherDenial } from ${JSON.stringify(new URL('dispatcher-protocol.mjs', lib).href)};
    import { orderDiagnosticMessage } from ${JSON.stringify(new URL('order-diagnostics.mjs', lib).href)};
    import { checkOutgoingRefusal } from ${JSON.stringify(new URL('order-text-record.mjs', lib).href)};
    import { decidePreToolUse, HANDBACK_TOOL } from ${JSON.stringify(new URL('dispatcher-gate.mjs', lib).href)};
    ${body}
  `], {
    encoding: 'utf8', windowsHide: true, timeout: 10_000,
    env: { ...process.env, CODEX_BRIDGE_TEST_TMP: marker, CATALOG_TREE: root },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const directory = path.join(marker, 'order-text-violations');
  const entries = fs.existsSync(directory) ? fs.readdirSync(directory).flatMap((file) =>
    fs.readFileSync(path.join(directory, file), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse)) : [];
  return { entries, result };
}

for (const transport of ['deny', 'handback']) {
  test(`${transport}: a handwritten text parameter is journaled before recording the output`, () => {
    const { entries } = probe(transport === 'deny' ? `
      const sentence = dispatcherProtocolMessage('canonical-foreground', { extra: 'handwritten parameter' });
      const output = dispatcherDenial(sentence, 'command data');
      assert.equal(checkOutgoingRefusal(output, 'deny'), output);
    ` : `
      const output = orderDiagnosticMessage('dispatcher-order-refusal', { refusal: 'handwritten parameter' });
      assert.equal(output, 'FAIL — dispatcher gate: handwritten parameter');
      assert.equal(checkOutgoingRefusal(output, 'handback'), output);
    `);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, 'parameter');
    assert.equal(entries[0].builder, transport === 'deny' ? 'dispatcherProtocolMessage' : 'orderDiagnosticMessage');
    assert.equal(entries[0].parameter, transport === 'deny' ? 'extra' : 'refusal');
    assert.equal(entries[0].message, 'handwritten parameter');
    assert.notEqual(entries[0].pid, process.pid);
    assert.match(entries[0].stack, /checkOrderTextParameters/);
  });

  test(`${transport}: a handwritten final message is journaled without changing bytes`, () => {
    const { entries } = probe(`
      const output = 'handwritten outgoing message';
      assert.equal(checkOutgoingRefusal(output, '${transport}'), output);
    `);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, 'outgoing');
    assert.equal(entries[0].transport, transport);
    assert.equal(entries[0].message, 'handwritten outgoing message');
    assert.notEqual(entries[0].pid, process.pid);
    assert.match(entries[0].stack, /checkOutgoingRefusal/);
  });
}

test('runner stdout is forwarded as data with its exact CRLF, punctuation and trailing newline', () => {
  const output = 'ATTACH=C:/runs/a order-id=x\r\nFAIL — arbitrary runner text!\r\n';
  const { entries } = probe(`
    const output = ${JSON.stringify(output)};
    const decision = decidePreToolUse({
      payload: { tool_name: HANDBACK_TOOL }, order: { command: 'command data' },
      state: { runnerOutput: output, runnerFinal: true },
    });
    assert.equal(decision.message, output);
    assert.equal(checkOutgoingRefusal(decision.message, 'handback'), output);
  `);
  assert.deepEqual(entries, []);
});

test('denial checks reason text while leaving command data and frame bytes unchanged', () => {
  const { entries } = probe(`
    const reason = dispatcherProtocolMessage('canonical-foreground');
    for (const command of [undefined, '', null, 42, 'arbitrary command data']) {
      const expected = 'codex-bridge dispatcher gate: ' + reason +
        (typeof command === 'string' && command.length > 0
          ? '\\n' + command + '\\nRun it exactly, in the foreground; repeating it attaches to the same run.' : '');
      assert.equal(checkOutgoingRefusal(dispatcherDenial(reason, command), 'deny'), expected);
    }
    assert.equal(dispatcherDenial('handwritten reason', undefined),
      'codex-bridge dispatcher gate: handwritten reason');
  `);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'parameter');
  assert.equal(entries[0].builder, 'dispatcherProtocolMessage');
  assert.equal(entries[0].key, 'denial');
  assert.equal(entries[0].parameter, 'reason');
  assert.equal(entries[0].message, 'handwritten reason');
});

test('a handwritten deny frame cannot borrow the catalog reason to escape the outgoing journal', () => {
  const { entries } = probe(`
    const reason = dispatcherProtocolMessage('canonical-foreground');
    const output = \`codex-bridge dispatcher gate (hand text): \${reason}\`;
    assert.equal(checkOutgoingRefusal(output, 'deny'), output);
  `);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'outgoing');
  assert.equal(entries[0].transport, 'deny');
  assert.equal(entries[0].message, 'codex-bridge dispatcher gate (hand text): ' +
    dispatcherProtocolMessage('canonical-foreground'));
  assert.notEqual(entries[0].pid, process.pid);
});

// D8: exercise the real emit boundary using a bounded fault injection in an isolated hook copy.
function hookProbe(decision, throws = false) {
  const root = makeTempTree('dispatcher-hook-transport-');
  const marker = path.join(root, 'marker');
  const fault = `export const HANDBACK_TOOL = 'SubagentHandback';
    export function gateOrder() { ${throws ? "throw new Error('injected failure')" : "return { command: 'command data' }"}; }
    export function decidePreToolUse() { return ${JSON.stringify(decision)}; }
    export function isFinalOutput() { return true; }
    export function runnerOutput() { return null; }`;
  const injected = 'data:text/javascript,' + encodeURIComponent(fault);
  const source = fs.readFileSync(hook, 'utf8').replace(/from '\.\.\/lib\/([^']+)'/g, (_, file) =>
    `from ${JSON.stringify(file === 'dispatcher-gate.mjs' ? injected : new URL(file, lib).href)}`);
  const entry = path.join(root, 'hook.mjs');
  fs.writeFileSync(entry, source);
  const result = spawnSync(process.execPath, [entry], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse', agent_type: ORDER_AGENTS[0],
      session_id: 'catalog-session', agent_id: 'catalog-agent',
      tool_name: decision.kind === 'allow' ? 'SubagentHandback' : 'Bash', tool_input: {},
    }),
    encoding: 'utf8', windowsHide: true, timeout: 10_000,
    env: { ...process.env, CODEX_BRIDGE_HOME: path.join(root, 'home'), CODEX_BRIDGE_TEST_TMP: marker },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const directory = path.join(marker, 'order-text-violations');
  const entries = fs.existsSync(directory) ? fs.readdirSync(directory).flatMap((file) =>
    fs.readFileSync(path.join(directory, file), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse)) : [];
  return { entries, result };
}

for (const [kind, transport, field, outputField] of [
  ['deny', 'deny', 'reason', 'permissionDecisionReason'],
  ['allow', 'handback', 'message', 'updatedInput'],
]) {
  test(`hook checks its final ${transport} transport and preserves the output frame`, () => {
    const message = 'unregistered final message';
    const { entries, result } = hookProbe({ kind, [field]: message });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, 'outgoing');
    assert.equal(entries[0].transport, transport);
    const expected = { hookEventName: 'PreToolUse', permissionDecision: kind,
      [outputField]: kind === 'allow' ? { message } : message };
    assert.equal(result.stdout, JSON.stringify({ hookSpecificOutput: expected }) + '\n');
  });
}

test('hook catch branch uses the checked internal diagnostic with unchanged bytes and exit code', () => {
  const { entries, result } = hookProbe({ kind: 'deny' }, true);
  assert.deepEqual(entries, []);
  assert.equal(result.stdout, JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PreToolUse', permissionDecision: 'deny',
    permissionDecisionReason: 'codex-bridge dispatcher gate: internal error: injected failure',
  } }) + '\n');
});
