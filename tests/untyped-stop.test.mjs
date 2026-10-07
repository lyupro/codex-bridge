import assert from 'node:assert/strict';
import { test } from 'node:test';
import { untypedStopEvidence } from '../src/home/lib/untyped-stop.mjs';
import { ORDER_AGENTS } from '../src/home/lib/order-schema.mjs';
import { CLI_NAMES } from '../src/home/lib/cli-names.mjs';

const COMMAND = 'codex-bridge run --agent codex-build --task-file task.md';
const NO_EVIDENCE = { dispatcher: false, reason: 'no-evidence' };
const bash = (command) => ({ id: 'run', name: 'Bash', command });

test('active registered gate state wins over command evidence and unreadable transcripts', () => {
  for (const agentType of ORDER_AGENTS) {
    const state = Object.freeze({ agentType, seenToolUseIds: Object.freeze(['receipt']) });
    for (const toolUses of [null, [], [bash(COMMAND)]]) {
      assert.deepEqual(untypedStopEvidence({ state, toolUses }), {
        dispatcher: true, via: 'gate-state', agentType,
      });
    }
  }
});

test('identity-only, corrupt, unregistered and malformed states are not evidence', () => {
  const arrayState = Object.assign([], { agentType: 'codex-build', seenToolUseIds: ['receipt'] });
  for (const state of [
    null, {}, 'codex-build', arrayState,
    { sessionId: 'session', agentId: 'agent', agentType: 'codex-build' },
    { agentType: 'codex-build', seenToolUseIds: [] },
    { agentType: 'codex-build', seenToolUseIds: 'receipt' },
    { agentType: 'codex-build', seenToolUseIds: ['receipt'], corrupt: true },
    { agentType: 'unknown', seenToolUseIds: ['receipt'] },
    { agentType: 42, seenToolUseIds: ['receipt'] },
    { seenToolUseIds: ['receipt'] },
  ]) {
    assert.deepEqual(untypedStopEvidence({ state, toolUses: [] }), NO_EVIDENCE);
  }
});

test('standalone registered run commands support both CLI names and whitespace', () => {
  for (const cli of CLI_NAMES) {
    for (const runAgent of ORDER_AGENTS) {
      const command = `  ${cli}\trun --task-file task.md --agent ${runAgent}  `;
      assert.deepEqual(untypedStopEvidence({ state: null, toolUses: [bash(command)] }), {
        dispatcher: true, via: 'run-command', runAgent,
      });
    }
  }
});

test('invalid gate state falls through and command role stays data, not the enclosing type', () => {
  const state = { agentType: 'unknown', seenToolUseIds: ['receipt'], corrupt: true };
  const toolUses = Object.freeze([Object.freeze({ name: 'Read', command: COMMAND }), Object.freeze(bash(COMMAND))]);
  assert.deepEqual(untypedStopEvidence({ state, toolUses }), {
    dispatcher: true, via: 'run-command', runAgent: 'codex-build',
  });
});

test('shell operators and expansion anywhere in the original command are never evidence', () => {
  for (const suffix of [' | cat', ' && echo ok', ' $(echo ok)', '; echo ok', ' & echo ok',
    ' `echo ok`', ' $HOME', ' < input', ' > output', '\n', '\r\n']) {
    assert.deepEqual(untypedStopEvidence({ state: null, toolUses: [bash(COMMAND + suffix)] }), NO_EVIDENCE);
  }
});

test('substrings, prose, wrong verbs and missing or unknown agent values are not evidence', () => {
  for (const command of [
    `echo ${COMMAND}`, `Please execute ${COMMAND}`, `prefix-${COMMAND}`,
    'codex-bridge runs --agent codex-build', 'codex-bridge run --agent unknown',
    'codex-bridge run --agent', 'codex-bridge run --task-file task.md',
    'codex-bridge run --agent=codex-build', 'codex-bridge run --agent codex-build-extra',
    'codex-bridge run --agent "codex-build"', '', 42,
  ]) {
    assert.deepEqual(untypedStopEvidence({ state: null, toolUses: [bash(command)] }), NO_EVIDENCE);
  }
});

test('non-Bash tool uses, prose, user messages and tool results are not evidence', () => {
  for (const toolUse of [
    { name: 'Read', command: COMMAND },
    { type: 'text', text: COMMAND },
    { type: 'user', message: { content: COMMAND } },
    { type: 'tool_result', content: COMMAND },
    { name: 'Bash', input: { command: COMMAND } },
  ]) {
    assert.deepEqual(untypedStopEvidence({ state: null, toolUses: [toolUse] }), NO_EVIDENCE);
  }
});

test('unreadable transcripts are distinguished from readable transcripts with no evidence', () => {
  assert.deepEqual(untypedStopEvidence({ state: null, toolUses: null }), {
    dispatcher: false, reason: 'transcript-unreadable',
  });
  assert.deepEqual(untypedStopEvidence({ state: null, toolUses: [] }), NO_EVIDENCE);
});
