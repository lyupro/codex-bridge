/** Verifies host transcript lookup and fail-closed extraction of the ordered prompt. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withTempTree } from './temp-tree.mjs';
import { ownTranscriptPath, transcriptOrderId, transcriptPrompt } from '../src/home/lib/dispatcher-order.mjs';

test('ownTranscriptPath locates the subagent transcript beside either parent path style', () => {
  for (const transcript_path of [String.raw`C:\Users\operator\x.jsonl`, '/home/operator/x.jsonl']) {
    const expected = path.join(path.dirname(transcript_path), 'session-123', 'subagents', 'agent-456.jsonl');
    assert.equal(ownTranscriptPath({ transcript_path, session_id: 'session-123', agent_id: '456' }), expected);
  }
});

test('ownTranscriptPath rejects missing fields and path-like session or agent ids', () => {
  const valid = { transcript_path: '/home/operator/x.jsonl', session_id: 'session-123', agent_id: '456' };
  for (const input of [
    null,
    {},
    { ...valid, transcript_path: '' },
    { ...valid, session_id: 123 },
    { ...valid, session_id: '' },
    { ...valid, agent_id: '' },
    { ...valid, session_id: 'session/child' },
    { ...valid, session_id: 'session\\child' },
    { ...valid, session_id: 'session..child' },
    { ...valid, agent_id: 'agent/child' },
    { ...valid, agent_id: 'agent\\child' },
    { ...valid, agent_id: '..' },
  ]) assert.equal(ownTranscriptPath(input), null, JSON.stringify(input));
});

test('transcriptPrompt returns string content and joins text parts from array content', async () => {
  await withTempTree('dispatcher-order-', async (directory) => {
    const stringPath = path.join(directory, 'string.jsonl');
    fs.writeFileSync(stringPath, `${JSON.stringify({ type: 'user', message: { content: 'order id: string-order' } })}\n`);
    assert.equal(transcriptPrompt(stringPath), 'order id: string-order');

    const arrayPath = path.join(directory, 'array.jsonl');
    fs.writeFileSync(arrayPath, `${JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'text', text: 'order id: array-order' }, { type: 'image', source: 'ignored' }, { type: 'text', text: 'task file: /tmp/task.md' }] },
    })}\n`);
    assert.equal(transcriptPrompt(arrayPath), 'order id: array-order\ntask file: /tmp/task.md');
  });
});

test('transcriptPrompt returns null for unavailable, malformed, or non-user first entries', async () => {
  await withTempTree('dispatcher-order-', async (directory) => {
    assert.equal(transcriptPrompt(path.join(directory, 'missing.jsonl')), null);
    const malformedPath = path.join(directory, 'malformed.jsonl');
    fs.writeFileSync(malformedPath, 'not-json\n');
    assert.equal(transcriptPrompt(malformedPath), null);
    const assistantPath = path.join(directory, 'assistant.jsonl');
    fs.writeFileSync(assistantPath, `${JSON.stringify({ type: 'assistant', message: { content: 'order id: ignored' } })}\n`);
    assert.equal(transcriptPrompt(assistantPath), null);
  });
});

test('transcriptOrderId retains order extraction and the empty fail-open result', async () => {
  await withTempTree('dispatcher-order-', async (directory) => {
    const transcriptPath = path.join(directory, 'valid.jsonl');
    fs.writeFileSync(transcriptPath, `${JSON.stringify({ type: 'user', message: { content: 'order id: plan-62-order' } })}\n`);
    assert.equal(transcriptOrderId(transcriptPath), 'plan-62-order');
    assert.equal(transcriptOrderId(path.join(directory, 'missing.jsonl')), '');
  });
});
