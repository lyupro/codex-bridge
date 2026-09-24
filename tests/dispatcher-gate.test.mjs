import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalRunCommand } from '../src/home/lib/dispatcher-command.mjs';
import {
  decidePreToolUse,
  gateOrder,
  HANDBACK_TOOL,
  isFinalOutput,
  runnerOutput,
} from '../src/home/lib/dispatcher-gate.mjs';

const prompt = 'order id: order-62\nscope: src/home\ntask file: C:/abs/task.md';
const command = canonicalRunCommand('codex-build', prompt).command;

test('runnerOutput captures stdout and strips an exit-code line from failures', () => {
  assert.deepEqual(runnerOutput({
    hook_event_name: 'PostToolUse',
    tool_response: { stdout: 'OK — done' },
  }), { output: 'OK — done', exitCode: 0 });
  assert.deepEqual(runnerOutput({
    hook_event_name: 'PostToolUseFailure',
    error: 'Exit code 7\nFAIL — boom',
  }), { output: 'FAIL — boom', exitCode: 7 });
  assert.deepEqual(runnerOutput({
    hook_event_name: 'PostToolUseFailure',
    error: 'runner refused the order',
  }), { output: 'runner refused the order', exitCode: null });
  assert.equal(runnerOutput({ hook_event_name: 'PostToolUse', tool_response: {} }), null);
  assert.equal(runnerOutput({ hook_event_name: 'PostToolUseFailure', error: 1 }), null);
  assert.equal(runnerOutput({ hook_event_name: 'PostToolUseFailure', error: 'Exit code 2' }), null);
});

test('isFinalOutput leaves STARTED replies open and accepts verdicts and refusals', () => {
  assert.equal(isFinalOutput('STARTED run-62\nThe runner is working.'), false);
  assert.equal(isFinalOutput('OK — completed'), true);
  assert.equal(isFinalOutput('FAIL — blocked'), true);
  assert.equal(isFinalOutput('Refused: invalid order'), true);
});

test('gateOrder derives the canonical command from the owned transcript order', () => {
  const order = gateOrder({ agent_type: 'codex-build' });
  assert.equal(order.command, undefined);
  assert.match(order.refusal, /agent transcript \(none\)/);
});

test('decidePreToolUse passes only the canonical foreground Bash command', () => {
  assert.deepEqual(decidePreToolUse({
    payload: { tool_name: 'Bash', tool_input: { command: `  ${command}  ` } },
    order: { command },
    state: {},
  }), { kind: 'pass' });

  const reordered = command.replace(
    '--scope "src/home" --order-id "order-62"',
    '--order-id "order-62" --scope "src/home"',
  );
  assert.notEqual(reordered, command);
  for (const tool_input of [
    { command, run_in_background: true },
    { command: reordered },
  ]) {
    const decision = decidePreToolUse({
      payload: { tool_name: 'Bash', tool_input }, order: { command }, state: {},
    });
    assert.equal(decision.kind, 'deny');
    assert.match(decision.reason, /^codex-bridge dispatcher gate:/);
    assert.ok(decision.reason.endsWith(`\n${command}\nRun it exactly, in the foreground; repeating it attaches to the same run.`));
  }
});

test('decidePreToolUse denies other tools and refuses all work when no order is readable', () => {
  const other = decidePreToolUse({
    payload: { tool_name: 'Write' }, order: { command }, state: {},
  });
  assert.equal(other.kind, 'deny');
  assert.ok(other.reason.endsWith(`\n${command}\nRun it exactly, in the foreground; repeating it attaches to the same run.`));

  const refusal = { refusal: 'the order could not be read from the agent transcript (none)' };
  const bash = decidePreToolUse({ payload: { tool_name: 'Bash' }, order: refusal, state: {} });
  assert.equal(bash.kind, 'deny');
  assert.match(bash.reason, /nothing may run, so hand back now/);
  const handback = decidePreToolUse({ payload: { tool_name: HANDBACK_TOOL }, order: refusal, state: {} });
  assert.equal(handback.kind, 'allow');
  assert.equal(handback.message, `FAIL — dispatcher gate: ${refusal.refusal}`);
});

test('decidePreToolUse substitutes only a final runner output at handback', () => {
  const final = decidePreToolUse({
    payload: { tool_name: HANDBACK_TOOL }, order: { command },
    state: { runnerOutput: 'FAIL — boom', runnerFinal: true },
  });
  assert.deepEqual(final, {
    kind: 'allow', message: 'FAIL — boom', stateUpdate: { handback: 'delivered' },
  });

  const started = decidePreToolUse({
    payload: { tool_name: HANDBACK_TOOL }, order: { command },
    state: { runnerOutput: 'STARTED run-62', runnerFinal: false },
  });
  assert.equal(started.kind, 'deny');
  assert.ok(started.reason.endsWith(`\n${command}\nRun it exactly, in the foreground; repeating it attaches to the same run.`));
});

test('decidePreToolUse records first premature handback and reports repeat handback', () => {
  const first = decidePreToolUse({
    payload: { tool_name: HANDBACK_TOOL }, order: { command }, state: {},
  });
  assert.equal(first.kind, 'deny');
  assert.deepEqual(first.stateUpdate, { handbackAttempts: 1 });
  assert.ok(first.reason.includes(`\n${command}\n`));

  const second = decidePreToolUse({
    payload: { tool_name: HANDBACK_TOOL }, order: { command }, state: { handbackAttempts: 1 },
  });
  assert.equal(second.kind, 'allow');
  assert.equal(second.message, 'FAIL — dispatcher did not delegate: it handed back without running `' + command + '`');
  assert.deepEqual(second.stateUpdate, { handbackAttempts: 2, handback: 'delivered' });
});

test('decidePreToolUse seals every tool, the canonical command included, after delivery', () => {
  for (const payload of [
    { tool_name: 'Bash', tool_input: { command } },
    { tool_name: HANDBACK_TOOL, tool_input: { message: 'OK' } },
    { tool_name: 'Read', tool_input: {} },
  ]) {
    const decision = decidePreToolUse({ payload, order: { command }, state: { handback: 'delivered' } });
    assert.equal(decision.kind, 'deny');
    assert.match(decision.reason, /already delivered/);
    assert.ok(!decision.reason.includes(command), 'a sealed dispatcher must not be told what to run');
  }
});
