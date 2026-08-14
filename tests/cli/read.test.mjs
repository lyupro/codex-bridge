/** Verifies the operator read command renders structured events without reading raw.log. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveProjectRunsDir } from '../../src/home/lib/runner/project-dir.mjs';
import { main } from '../../bin/codex-bridge.mjs';
import { read } from '../../cli/read.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'read-'));
  const project = path.join(root, 'project');
  const runsRoot = path.join(root, 'runs');
  fs.mkdirSync(project);
  const projectRuns = resolveProjectRunsDir(runsRoot, project).dir;
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { project, projectRuns, runsRoot };
}

function runDir(fixtureData, name = '2026-08-04_090000_read-test') {
  const dir = path.join(fixtureData.projectRuns, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeEvents(dir, events) {
  fs.writeFileSync(path.join(dir, 'events.jsonl'), events);
}

test('read renders thread id, agent text, and usage numbers in event order', (t) => {
  const data = fixture(t);
  const dir = runDir(data);
  writeEvents(dir, [
    { type: 'thread.started', thread_id: 'thread-read-16' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'The requested change is ready.' } },
    { type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 7 } },
  ].map((event) => JSON.stringify(event)).join('\n') + '\n');

  const result = read({ run: path.basename(dir), cwd: data.project, runsRootPath: data.runsRoot });

  assert.equal(result.exitCode, 0);
  assert.match(result.output, /thread\.started[\s\S]*Thread ID: thread-read-16/);
  assert.match(result.output, /agent_message[\s\S]*The requested change is ready\./);
  assert.match(result.output, /turn\.completed[\s\S]*input_tokens=12, output_tokens=7/);
});

test('read renders structural service events on one line', (t) => {
  const data = fixture(t);
  const dir = runDir(data);
  writeEvents(dir, [
    { type: 'thread.started', thread_id: 'thread-service' },
    { type: 'turn.started' },
    { type: 'item.started', item: { type: 'agent_message' } },
  ].map((event) => JSON.stringify(event)).join('\n') + '\n');

  const result = read({ run: path.basename(dir), cwd: data.project, runsRootPath: data.runsRoot });

  assert.equal(result.exitCode, 0);
  assert.match(result.output, /^thread\.started[^\r\n]*Thread ID: thread-service$/m);
  assert.match(result.output, /^turn\.started$/m);
  assert.match(result.output, /^item\.started[^\r\n]*Item: agent_message$/m);
});

test('read keeps an unknown event type with its full compact JSON tail', (t) => {
  const data = fixture(t);
  const dir = runDir(data);
  const detail = 'kept '.repeat(80).trim();
  writeEvents(dir, `${JSON.stringify({ type: 'future.event', detail })}\n`);

  const result = read({ run: path.basename(dir), cwd: data.project, runsRootPath: data.runsRoot });

  assert.equal(result.exitCode, 0);
  assert.match(result.output, new RegExp(`future\\.event: \\{"type":"future\\.event","detail":"${detail}"\\}`));
});

test('read ignores a truncated final JSONL line after rendering complete events', (t) => {
  const data = fixture(t);
  const dir = runDir(data);
  writeEvents(
    dir,
    `${JSON.stringify({ type: 'thread.started', thread_id: 'thread-read-17' })}\n` +
      `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Still visible.' } })}\n` +
      '{"type":"turn.completed","usage":{"input_tokens":',
  );

  const result = read({ run: path.basename(dir), cwd: data.project, runsRootPath: data.runsRoot });

  assert.equal(result.exitCode, 0);
  assert.match(result.output, /thread-read-17/);
  assert.match(result.output, /Still visible\./);
});

test('read refuses a run from before the event stream was added', (t) => {
  const data = fixture(t);
  const dir = runDir(data);

  const result = read({ run: path.basename(dir), cwd: data.project, runsRootPath: data.runsRoot });

  assert.equal(result.exitCode, 1);
  assert.equal(result.output.split(/\r?\n/).length, 1);
  assert.match(result.output, /no events\.jsonl.*predates the event stream/i);
});

/**
 * An empty stream is not an old run: the file is there, so the runner did ask for events and
 * Codex died before saying one. Telling the operator it "predates the change" would send them
 * looking for a version problem that is not there.
 */
test('read tells an empty event stream apart from a missing one', (t) => {
  const data = fixture(t);
  const dir = runDir(data);
  writeEvents(dir, '');

  const result = read({ run: path.basename(dir), cwd: data.project, runsRootPath: data.runsRoot });

  assert.equal(result.exitCode, 1);
  assert.match(result.output, /empty events\.jsonl/i);
  assert.doesNotMatch(result.output, /predates/i);
});

test('read refuses a missing run directory without naming stop', (t) => {
  const data = fixture(t);
  const missing = path.join(data.project, 'no-such-run');

  const result = read({ run: missing, cwd: data.project, runsRootPath: data.runsRoot });

  assert.equal(result.exitCode, 1);
  assert.match(result.output, /Run folder not found/);
  assert.doesNotMatch(result.output, /stop/);
});

test('read names itself when the run argument is missing', (t) => {
  const data = fixture(t);

  const result = read({ run: '', cwd: data.project, runsRootPath: data.runsRoot });

  assert.equal(result.exitCode, 1);
  assert.match(result.output, /codex-bridge read: read requires a run folder/);
  assert.doesNotMatch(result.output, /codex-bridge stop/);
});

test('the dispatcher routes read output for an absolute run path and rejects log', async (t) => {
  const data = fixture(t);
  const dir = runDir(data);
  writeEvents(dir, `${JSON.stringify({ type: 'thread.started', thread_id: 'thread-dispatch' })}\n`);
  const output = [];
  const errors = [];

  const code = await main(['read', dir], {
    log: (line) => output.push(line),
    error: (line) => errors.push(line),
  });

  assert.equal(code, 0);
  assert.equal(errors.length, 0);
  assert.match(output[0], /thread-dispatch/);

  const oldCommandErrors = [];
  const oldCommandCode = await main(['log', dir], {
    log: (line) => output.push(line),
    error: (line) => oldCommandErrors.push(line),
  });

  assert.equal(oldCommandCode, 2);
  assert.match(oldCommandErrors[0], /unknown command "log"/);
});

test('read reports transport status and message from an event payload', (t) => {
  const data = fixture(t);
  const dir = runDir(data);
  writeEvents(dir, `${JSON.stringify({ type: 'error', status: 503, message: 'service unavailable' })}\n`);

  const result = read({ run: path.basename(dir), cwd: data.project, runsRootPath: data.runsRoot });

  assert.equal(result.exitCode, 0);
  assert.match(result.output, /error[\s\S]*Status: 503[\s\S]*Message: service unavailable/);
});
