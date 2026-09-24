import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { buildRig } from '../../cli/probe-rig.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

const invoke = (hook, event, payload) => spawnSync(process.execPath, [hook, event], { input: JSON.stringify(payload), encoding: 'utf8' });

test('buildRig writes the three Bash hooks and an inheriting probe agent', async () => {
  const root = makeTempTree('probe-rig-');
  try {
    const rig = await buildRig(root, '1234abcd');
    const settings = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
    assert.deepEqual(Object.keys(settings.hooks), ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);
    for (const [key, event] of [['PreToolUse', 'PreToolUse'], ['PostToolUse', 'PostToolUse'], ['PostToolUseFailure', 'PostToolUseFailure']]) {
      assert.equal(settings.hooks[key][0].matcher, 'Bash');
      assert.match(settings.hooks[key][0].hooks[0].command, new RegExp(` ${event}$`));
    }
    const agent = fs.readFileSync(path.join(root, '.claude', 'agents', 'probe-agent.md'), 'utf8');
    assert.match(agent, /tools: Bash/);
    assert.doesNotMatch(agent, /^model:/m);
    assert.match(rig.prompt, /sub_type|subagent_type/);
    assert.equal(rig.token, '1234abcd');
  } finally { removeTempTree(root); }
});

test('hook denies only the exact refusal and records it', async () => {
  const root = makeTempTree('probe-rig-deny-');
  try {
    const rig = await buildRig(root, '1234abcd');
    const hook = path.join(root, '.claude', 'hooks', 'probe-hook.mjs');
    const denied = invoke(hook, 'PreToolUse', { tool_input: { command: rig.refusalCommand } });
    assert.equal(denied.status, 0);
    assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, 'deny');
    const unrelated = invoke(hook, 'PreToolUse', { tool_input: { command: 'pwd' } });
    const substring = invoke(hook, 'PreToolUse', { tool_input: { command: rig.refusalCommand.replace('touch ', '') } });
    assert.equal(unrelated.stdout, '');
    assert.equal(substring.stdout, '');
    const entries = fs.readFileSync(rig.dispatcherJournalPath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(entries.length, 3);
    assert.equal(fs.readFileSync(rig.journalPath, 'utf8'), 'codex-bridge-contract-probe\n');
  } finally { removeTempTree(root); }
});

test('hook journals the whole first transcript line or its read error', async () => {
  const root = makeTempTree('probe-rig-transcript-');
  try {
    const rig = await buildRig(root, '1234abcd');
    const hook = path.join(root, '.claude', 'hooks', 'probe-hook.mjs');
    const transcriptDir = path.join(root, 'session', 'subagents');
    fs.mkdirSync(transcriptDir, { recursive: true });
    const firstLine = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(10000) } });
    fs.writeFileSync(path.join(transcriptDir, 'agent-agent1.jsonl'), `${firstLine}\nsecond`, 'utf8');
    const payload = { agent_id: 'agent1', session_id: 'session', transcript_path: path.join(root, 'transcript.jsonl'), tool_input: { command: rig.okCommand } };
    invoke(hook, 'PreToolUse', payload);
    invoke(hook, 'PreToolUse', { ...payload, agent_id: 'missing' });
    const entries = fs.readFileSync(rig.dispatcherJournalPath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(entries[0].transcript.firstLine, firstLine);
    assert.equal(entries[1].transcript.error, 'ENOENT');
  } finally { removeTempTree(root); }
});

test('PostToolUse and PostToolUseFailure preserve raw payloads', async () => {
  const root = makeTempTree('probe-rig-events-');
  try {
    const rig = await buildRig(root, '1234abcd');
    const hook = path.join(root, '.claude', 'hooks', 'probe-hook.mjs');
    const post = { tool_response: { stdout: 'raw' } };
    const failure = { error: 'Exit code 2' };
    invoke(hook, 'PostToolUse', post);
    invoke(hook, 'PostToolUseFailure', failure);
    const entries = fs.readFileSync(rig.dispatcherJournalPath, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(entries.map(({ event, payload }) => ({ event, payload })), [
      { event: 'PostToolUse', payload: post }, { event: 'PostToolUseFailure', payload: failure },
    ]);
  } finally { removeTempTree(root); }
});
