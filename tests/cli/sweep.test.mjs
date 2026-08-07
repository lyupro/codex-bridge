/** Verifies sweep closes only dead-pid records and reports live stalled runs. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sweep } from '../../cli/sweep.mjs';
import { HEARTBEAT_FILE, HEARTBEAT_STALE_MS } from '../../src/heartbeat.mjs';

const DEAD_PID = 999999999;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-command-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function makeRun(root, project, run, status) {
  const dir = path.join(root, project, run);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'status.json'), `${JSON.stringify(status)}\n`);
  return dir;
}

function makeStaleHeartbeat(runDir) {
  const heartbeat = path.join(runDir, HEARTBEAT_FILE);
  fs.writeFileSync(heartbeat, 'progress\n');
  const at = new Date(Date.now() - HEARTBEAT_STALE_MS - 1_000);
  fs.utimesSync(heartbeat, at, at);
}

test('sweep closes a dead-pid running record and reports it', (t) => {
  const root = fixture(t);
  const run = '2026-08-06_204007_build';
  const dir = makeRun(root, 'alpha', run, {
    state: 'running',
    pid: DEAD_PID,
    agent: 'codex-build',
    repo: path.join(root, 'repository'),
  });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), 'keep me\n');

  const result = sweep([], { runsRootPath: root });

  assert.equal(result.exitCode, 0);
  assert.match(result.output, /Closed 1 running record/);
  assert.match(result.output, new RegExp(run));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8')).state, 'abandoned');
  assert.equal(fs.existsSync(dir), true);
  assert.equal(fs.existsSync(path.join(dir, 'events.jsonl')), true);
});

test('sweep leaves a live-pid stale-heartbeat record alone and names stop', (t) => {
  const root = fixture(t);
  const run = '2026-08-06_204008_stalled';
  const dir = makeRun(root, 'alpha', run, {
    state: 'running',
    pid: process.pid,
    agent: 'codex-build',
    repo: path.join(root, 'repository'),
  });
  makeStaleHeartbeat(dir);

  const result = sweep(['alpha'], { runsRootPath: root });

  assert.equal(result.exitCode, 0);
  assert.match(result.output, /live-pid run with stale heartbeat/);
  assert.match(result.output, new RegExp(run));
  assert.match(result.output, new RegExp(`codex-bridge stop ${run}`));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8')).state, 'running');
  assert.equal(fs.existsSync(path.join(dir, 'meta.json')), false);
});

test('sweep is idempotent and reports a clean store as success', (t) => {
  const root = fixture(t);
  const run = '2026-08-06_204009_idempotent';
  makeRun(root, 'alpha', run, { state: 'running', pid: DEAD_PID, agent: 'codex-build' });

  const first = sweep([], { runsRootPath: root });
  const second = sweep([], { runsRootPath: root });

  assert.equal(first.exitCode, 0);
  assert.match(first.output, /Closed 1 running record/);
  assert.equal(second.exitCode, 0);
  assert.match(second.output, /Nothing to close; the store is unchanged/);
  assert.match(second.output, /stale heartbeats left untouched: none/);

  const cleanRoot = fixture(t);
  const clean = sweep([], { runsRootPath: cleanRoot });
  assert.equal(clean.exitCode, 0);
  assert.match(clean.output, /Nothing to close; the store is unchanged/);
});
