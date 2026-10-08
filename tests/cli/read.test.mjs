/** Verifies the operator read command renders structured events without reading raw.log. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { resolveProjectRunsDir } from '../../src/home/lib/runner/project-dir.mjs';
import { main } from '../../bin/codex-bridge.mjs';
import { read } from '../../cli/read.mjs';
import { resolveRunFolder } from '../../cli/run-lookup.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

function fixture(t) {
  const root = makeTempTree('read-');
  const project = path.join(root, 'project');
  const runsRoot = path.join(root, 'runs');
  fs.mkdirSync(project);
  const projectRuns = resolveProjectRunsDir(runsRoot, project).dir;
  t.after(() => removeTempTree(root));
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

test('Plan_68 D6 keeps inline emoji and no-space CJK cuts well-formed', (t) => {
  for (const text of [`${'x'.repeat(299)}😀${'😀'.repeat(4)}`, '漢'.repeat(320)]) {
    const data = fixture(t);
    const dir = runDir(data);
    writeEvents(dir, `${JSON.stringify({
      type: 'item.completed', item: { type: 'future_item', text },
    })}\n`);

    const result = read({ run: path.basename(dir), cwd: data.project, runsRootPath: data.runsRoot });
    assert.equal(result.exitCode, 0);
    assert.ok(result.output.isWellFormed());
    assert.ok(result.output.includes(text.slice(0, 290)));
  }
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
  assert.equal(result.output, `Run ${dir} has no events.jsonl; it predates the event stream.`);
});

test('read names a refusal before Codex started when the event stream is missing', (t) => {
  const data = fixture(t);
  const dir = runDir(data, '2026-09-06_090000_refused');
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ state: 'aborted_pre_start' }));

  const result = read({ run: path.basename(dir), cwd: data.project, runsRootPath: data.runsRoot });

  assert.equal(result.exitCode, 1);
  assert.equal(result.output,
    `Run ${dir} was refused before Codex started (state aborted_pre_start), so it has no events.jsonl.`);
});

test('read asks the operator to retry a running run without an event stream', (t) => {
  const data = fixture(t);
  const dir = runDir(data);
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ state: 'running' }));

  const result = read({ run: path.basename(dir), cwd: data.project, runsRootPath: data.runsRoot });

  assert.equal(result.exitCode, 1);
  assert.equal(result.output,
    `Run ${dir} has no events.jsonl yet: Codex has not started; repeat the command shortly.`);
});

test('read keeps the legacy missing-stream explanation for other states and unreadable status', (t) => {
  for (const status of ['{"state":"completed"}', '{', 'null']) {
    const data = fixture(t);
    const dir = runDir(data);
    fs.writeFileSync(path.join(dir, 'status.json'), status);

    const result = read({ run: path.basename(dir), cwd: data.project, runsRootPath: data.runsRoot });

    assert.equal(result.exitCode, 1);
    assert.equal(result.output, `Run ${dir} has no events.jsonl; it predates the event stream.`);
  }
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

// Plan_77 D6, run-lookup.mjs:51-55: retired paths must refuse before stat, naming the new address.
test('read lookup refuses an absolute retired path before stat and names its equivalent', (t) => {
  const data = fixture(t);
  const oldRoot = path.join(data.project, 'old-runs');
  const run = path.join(oldRoot, 'Project', 'Run-ID');
  const resolution = { root: data.runsRoot, homeRoot: data.runsRoot,
    retired: [{ root: oldRoot }], staleOverride: null };
  const stat = t.mock.method(fs, 'statSync');
  const result = resolveRunFolder({ command: 'read', run, cwd: data.project, resolution });
  assert.deepEqual(result, { runDir: null,
    error: `codex-bridge read: Run records moved from ${oldRoot} to ${data.runsRoot}. ` +
      `Equivalent path: ${path.join(data.runsRoot, 'Project', 'Run-ID')}. ` +
      'Update advice: or pass this new path explicitly. No path was remapped.' });
  assert.equal(stat.mock.callCount(), 0);
});

test('read lookup keeps bare names under the injected current root', (t) => {
  const data = fixture(t);
  const dir = runDir(data);
  const resolution = { root: data.runsRoot, homeRoot: data.runsRoot,
    retired: [{ root: path.join(data.project, 'old-runs') }], staleOverride: null };
  assert.deepEqual(resolveRunFolder({
    command: 'read', run: path.basename(dir), cwd: data.project, resolution,
  }), { runDir: dir, error: null });
});

test('read lookup refuses a stale default override but honors an explicit current root', (t) => {
  const data = fixture(t);
  const dir = runDir(data);
  const oldRoot = path.join(data.project, 'old-runs');
  const staleRoot = path.join(oldRoot, 'Project');
  const resolution = { root: staleRoot, homeRoot: data.runsRoot,
    retired: [{ root: oldRoot }], staleOverride: { root: oldRoot, suffix: 'Project' } };
  const stat = t.mock.method(fs, 'statSync');
  const result = resolveRunFolder({ command: 'read', run: path.basename(dir), cwd: data.project, resolution });
  assert.equal(result.runDir, null);
  assert.equal(result.error, `codex-bridge read: Run records moved from ${oldRoot} to ${data.runsRoot}. ` +
    `Equivalent path: ${path.join(data.runsRoot, 'Project')}. ` +
    'Update advice: or pass this new path explicitly. No path was remapped.\n' +
    'CODEX_RUNS_ROOT points under a retired runs root; remove it or set it to the new location.');
  assert.equal(stat.mock.callCount(), 0);
  stat.mock.restore();
  assert.deepEqual(resolveRunFolder({
    command: 'read', run: path.basename(dir), cwd: data.project, runsRootPath: data.runsRoot, resolution,
  }), { runDir: dir, error: null });
  assert.equal(fs.existsSync(oldRoot), false);
});
