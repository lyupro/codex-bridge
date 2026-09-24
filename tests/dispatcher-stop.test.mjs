import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { decideDispatcherStop, transcriptToolUses } from '../src/home/lib/dispatcher-stop.mjs';
import { HANDBACK_TOOL } from '../src/home/lib/hook-definitions.mjs';
import { makeTempTree, removeTempTree } from './temp-tree.mjs';

test('transcriptToolUses reads assistant tool calls and skips other or broken lines', async (t) => {
  const root = makeTempTree('bridge-dispatcher-stop-');
  t.after(() => removeTempTree(root));
  const transcript = path.join(root, 'agent.jsonl');
  const lines = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'one', name: 'Bash' }] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_use', id: 'ignored', name: 'Read' }] } }),
    '{broken line',
    JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', id: 'two', name: HANDBACK_TOOL }] } }),
  ];
  await fs.writeFile(transcript, `${lines.join('\n')}\n`);

  assert.deepEqual(transcriptToolUses(transcript), [
    { id: 'one', name: 'Bash' },
    { id: 'two', name: HANDBACK_TOOL },
  ]);
  assert.equal(transcriptToolUses(path.join(root, 'missing.jsonl')), null);
});

test('decideDispatcherStop yields after a delivered handback', () => {
  assert.deepEqual(decideDispatcherStop({
    state: { handback: 'delivered', seenToolUseIds: ['one'] },
    toolUses: [{ id: 'one', name: 'Bash' }],
  }), { route: 'yield', unseen: [], stateUpdate: null });
});

test('decideDispatcherStop demands one handback then yields on the next stop', () => {
  const toolUses = [{ id: 'handback', name: HANDBACK_TOOL }];
  assert.deepEqual(decideDispatcherStop({ state: {}, toolUses }), {
    route: 'demand',
    unseen: [{ id: 'handback', name: HANDBACK_TOOL }],
    stateUpdate: { stopDemanded: true, auditAlarmed: true },
  });
  assert.deepEqual(decideDispatcherStop({
    state: { stopDemanded: true, seenToolUseIds: ['handback'] },
    toolUses,
  }), { route: 'yield', unseen: [], stateUpdate: null });
});

test('decideDispatcherStop keeps sessions without a handback attempt on legacy checks', () => {
  assert.deepEqual(decideDispatcherStop({ state: null, toolUses: [] }), {
    route: 'legacy', unseen: [], stateUpdate: null,
  });
});

test('decideDispatcherStop audits missing and corrupt receipts once, but ignores missing transcript evidence', () => {
  const toolUses = [{ id: 'one', name: 'Bash' }];
  assert.deepEqual(decideDispatcherStop({ state: null, toolUses }), {
    route: 'legacy', unseen: toolUses, stateUpdate: { auditAlarmed: true },
  });
  assert.deepEqual(decideDispatcherStop({ state: { corrupt: true, seenToolUseIds: ['one'] }, toolUses }), {
    route: 'legacy', unseen: toolUses, stateUpdate: { auditAlarmed: true },
  });
  assert.deepEqual(decideDispatcherStop({ state: { auditAlarmed: true }, toolUses }), {
    route: 'legacy', unseen: [], stateUpdate: null,
  });
  assert.deepEqual(decideDispatcherStop({ state: null, toolUses: null }), {
    route: 'legacy', unseen: [], stateUpdate: null,
  });
});
