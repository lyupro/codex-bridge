/** Verifies the operator log renders structured events without reading raw.log. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveProjectRunsDir } from '../../src/runner/project-dir.mjs';
import { main } from '../../bin/codex-bridge.mjs';
import { log } from '../../cli/log.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'log-'));
  const project = path.join(root, 'project');
  const runsRoot = path.join(root, 'runs');
  fs.mkdirSync(project);
  const projectRuns = resolveProjectRunsDir(runsRoot, project).dir;
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { project, projectRuns, runsRoot };
}

function runDir(fixtureData, name = '2026-08-04_090000_log-test') {
  const dir = path.join(fixtureData.projectRuns, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeEvents(dir, events) {
  fs.writeFileSync(path.join(dir, 'events.jsonl'), events);
}

test('log renders thread id, agent text, and usage numbers in event order', (t) => {
  const data = fixture(t);
  const dir = runDir(data);
  writeEvents(dir, [
    { type: 'thread.started', thread_id: 'thread-log-16' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'The requested change is ready.' } },
    { type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 7 } },
  ].map((event) => JSON.stringify(event)).join('\n') + '\n');

  const result = log({ run: path.basename(dir), cwd: data.project, runsRootPath: data.runsRoot });

  assert.equal(result.exitCode, 0);
  assert.match(result.output, /thread\.started[\s\S]*Thread ID: thread-log-16/);
  assert.match(result.output, /agent_message[\s\S]*The requested change is ready\./);
  assert.match(result.output, /turn\.completed[\s\S]*input_tokens=12, output_tokens=7/);
});

test('log keeps an unknown event type with a compact JSON tail', (t) => {
  const data = fixture(t);
  const dir = runDir(data);
  writeEvents(dir, `${JSON.stringify({ type: 'future.event', detail: 'kept' })}\n`);

  const result = log({ run: path.basename(dir), cwd: data.project, runsRootPath: data.runsRoot });

  assert.equal(result.exitCode, 0);
  assert.match(result.output, /future\.event: \{"type":"future\.event","detail":"kept"\}/);
});

test('log ignores a truncated final JSONL line after rendering complete events', (t) => {
  const data = fixture(t);
  const dir = runDir(data);
  writeEvents(
    dir,
    `${JSON.stringify({ type: 'thread.started', thread_id: 'thread-log-17' })}\n` +
      `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Still visible.' } })}\n` +
      '{"type":"turn.completed","usage":{"input_tokens":',
  );

  const result = log({ run: path.basename(dir), cwd: data.project, runsRootPath: data.runsRoot });

  assert.equal(result.exitCode, 0);
  assert.match(result.output, /thread-log-17/);
  assert.match(result.output, /Still visible\./);
});

test('log refuses a run from before the event stream was added', (t) => {
  const data = fixture(t);
  const dir = runDir(data);

  const result = log({ run: path.basename(dir), cwd: data.project, runsRootPath: data.runsRoot });

  assert.equal(result.exitCode, 1);
  assert.equal(result.output.split(/\r?\n/).length, 1);
  assert.match(result.output, /no events\.jsonl.*predates the event stream/i);
});

/**
 * An empty stream is not an old run: the file is there, so the runner did ask for events and
 * Codex died before saying one. Telling the operator it "predates the change" would send them
 * looking for a version problem that is not there.
 */
test('log tells an empty event stream apart from a missing one', (t) => {
  const data = fixture(t);
  const dir = runDir(data);
  writeEvents(dir, '');

  const result = log({ run: path.basename(dir), cwd: data.project, runsRootPath: data.runsRoot });

  assert.equal(result.exitCode, 1);
  assert.match(result.output, /empty events\.jsonl/i);
  assert.doesNotMatch(result.output, /predates/i);
});

test('log refuses a missing run directory without naming stop', (t) => {
  const data = fixture(t);
  const missing = path.join(data.project, 'no-such-run');

  const result = log({ run: missing, cwd: data.project, runsRootPath: data.runsRoot });

  assert.equal(result.exitCode, 1);
  assert.match(result.output, /Run folder not found/);
  assert.doesNotMatch(result.output, /stop/);
});

test('log names itself when the run argument is missing', (t) => {
  const data = fixture(t);

  const result = log({ run: '', cwd: data.project, runsRootPath: data.runsRoot });

  assert.equal(result.exitCode, 1);
  assert.match(result.output, /codex-bridge log: log requires a run folder/);
  assert.doesNotMatch(result.output, /codex-bridge stop/);
});

test('the dispatcher routes log output for an absolute run path', async (t) => {
  const data = fixture(t);
  const dir = runDir(data);
  writeEvents(dir, `${JSON.stringify({ type: 'thread.started', thread_id: 'thread-dispatch' })}\n`);
  const output = [];
  const errors = [];

  const code = await main(['log', dir], {
    log: (line) => output.push(line),
    error: (line) => errors.push(line),
  });

  assert.equal(code, 0);
  assert.equal(errors.length, 0);
  assert.match(output[0], /thread-dispatch/);
});

test('log reports transport status and message from an event payload', (t) => {
  const data = fixture(t);
  const dir = runDir(data);
  writeEvents(dir, `${JSON.stringify({ type: 'error', status: 503, message: 'service unavailable' })}\n`);

  const result = log({ run: path.basename(dir), cwd: data.project, runsRootPath: data.runsRoot });

  assert.equal(result.exitCode, 0);
  assert.match(result.output, /error[\s\S]*Status: 503[\s\S]*Message: service unavailable/);
});
