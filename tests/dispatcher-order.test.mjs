/** Verifies host transcript lookup and fail-closed extraction of the ordered prompt. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withTempTree } from './temp-tree.mjs';
import { bindReceipt, ownTranscriptPath, runnerReceipt, transcriptPrompt } from '../src/home/lib/dispatcher-order.mjs';

test('runnerReceipt extracts the first RUN or ATTACH folder without normalizing it', () => {
  for (const [output, expected] of [
    ['RUN=/runs/first order-id=order-63', '/runs/first'],
    ['ATTACH=/runs/first order-id=order-63 started=2026-10-05T00:00:00Z', '/runs/first'],
    ['RUN=/runs/a folder order-id=order-63', '/runs/a folder'],
    [String.raw`RUN=C:\runs\first order-id=order-63`, String.raw`C:\runs\first`],
    ['RUN=/runs/first order-id=order-63\r\nOK — done\r\n', '/runs/first'],
    ['Runner starting\nRUN=/runs/first order-id=order-63', '/runs/first'],
    ['RUN=/runs/first order-id=order-63\nATTACH=/runs/second order-id=other', '/runs/first'],
    ['ATTACH=/runs/first order-id=order-63\nRUN=/runs/second order-id=other', '/runs/first'],
    ['RUN=/runs/ order-id=in-folder order-id=order-63', '/runs/ order-id=in-folder'],
    ['RUN= /runs/first  order-id=order-63', ' /runs/first '],
    ['OK — done', null],
    [' RUN=/runs/first order-id=order-63', null],
    ['RUN= order-id=order-63\nRUN=/runs/second order-id=other', null],
    ['RUN=/runs/first', null],
    ['', null],
    [null, null],
    [undefined, null],
    [42, null],
    [{}, null],
  ]) assert.equal(runnerReceipt(output), expected, JSON.stringify(output));
});

test('bindReceipt binds once using exact equality and preserves the first conflict', () => {
  assert.deepEqual(bindReceipt({}, '/runs/first'), { runReceipt: '/runs/first' });
  assert.deepEqual(bindReceipt(undefined, '/runs/first'), { runReceipt: '/runs/first' });
  const state = { runReceipt: '/runs/first' };
  assert.deepEqual(bindReceipt(state, '/runs/first'), {});
  assert.deepEqual(bindReceipt(state, '/runs/second'), { runReceiptConflict: '/runs/second' });
  assert.deepEqual(bindReceipt(state, '/runs/first '), { runReceiptConflict: '/runs/first ' });
  const conflict = { ...state, runReceiptConflict: '/runs/second' };
  assert.deepEqual(bindReceipt(conflict, '/runs/third'), {});
  assert.deepEqual(bindReceipt(conflict, '/runs/first'), {});
  for (const value of [undefined, {}, state, conflict]) assert.deepEqual(bindReceipt(value, null), {});
  assert.deepEqual(state, { runReceipt: '/runs/first' });
  assert.deepEqual(conflict, { runReceipt: '/runs/first', runReceiptConflict: '/runs/second' });
});

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
