/** Verifies unlock closes only dead-pid records and reports identity reasons. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { unlock } from '../../cli/unlock.mjs';
import { HEARTBEAT_FILE, HEARTBEAT_STALE_MS } from '../../src/home/lib/heartbeat.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

const DEAD_PID = 999999999;

function fixture(t) {
  const root = makeTempTree('unlock-command-');
  t.after(() => removeTempTree(root));
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

test('unlock closes a dead-pid running record and reports it', (t) => {
  const root = fixture(t);
  const run = '2026-08-06_204007_build';
  const dir = makeRun(root, 'alpha', run, {
    state: 'running',
    pid: DEAD_PID,
    agent: 'codex-build',
    repo: path.join(root, 'repository'),
  });
  fs.writeFileSync(path.join(dir, 'events.jsonl'), 'keep me\n');

  const result = unlock(['--all'], { runsRootPath: root });

  assert.equal(result.exitCode, 0);
  assert.match(result.output, /Closed 1 running record/);
  assert.match(result.output, new RegExp(run));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8')).state, 'abandoned');
  assert.equal(fs.existsSync(dir), true);
  assert.equal(fs.existsSync(path.join(dir, 'events.jsonl')), true);
  assert.match(result.output, /age[\s\S]*silent for[\s\S]*identity[\s\S]*dead/);
});

test('unlock leaves an unverified stale-heartbeat record alone and explains why', (t) => {
  const root = fixture(t);
  const run = '2026-08-06_204008_stalled';
  const dir = makeRun(root, 'alpha', run, {
    state: 'running',
    pid: process.pid,
    agent: 'codex-build',
    repo: path.join(root, 'repository'),
  });
  makeStaleHeartbeat(dir);

  const result = unlock(['alpha'], { runsRootPath: root });

  assert.equal(result.exitCode, 0);
  assert.match(result.output, /identity[\s\S]*unverified/);
  assert.match(result.output, new RegExp(run));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8')).state, 'running');
  assert.equal(fs.existsSync(path.join(dir, 'meta.json')), false);
});

test('unlock refuses a confirmed-alive record and names stop', (t) => {
  const root = fixture(t);
  const run = '2026-08-06_204009_alive';
  const dir = makeRun(root, 'alpha', run, {
    state: 'running',
    pid: process.pid,
    agent: 'codex-build',
    repo: path.join(root, 'repository'),
    started_at: new Date(Date.now() - 1_000).toISOString(),
  });
  fs.writeFileSync(path.join(dir, HEARTBEAT_FILE), 'progress\n');

  const result = unlock(['alpha'], { runsRootPath: root });

  assert.equal(result.exitCode, 0);
  assert.match(result.output, /Refused to close 1 confirmed-alive run/);
  assert.match(result.output, new RegExp(`codex-bridge stop ${run}`));
  assert.match(result.output, /identity[\s\S]*alive/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8')).state, 'running');
  assert.equal(fs.existsSync(path.join(dir, 'meta.json')), false);
});

test('unlock without an argument acts on the current repository only', (t) => {
  const root = fixture(t);
  const current = path.join(root, 'repository');
  const currentRun = makeRun(root, 'repository', 'current-run', {
    state: 'running',
    pid: DEAD_PID,
    agent: 'codex-build',
    repo: current,
  });
  const otherRun = makeRun(root, 'other', 'other-run', {
    state: 'running',
    pid: DEAD_PID,
    agent: 'codex-build',
    repo: path.join(root, 'other-repository'),
  });

  const result = unlock([], { runsRootPath: root, cwd: current });

  assert.equal(result.exitCode, 0);
  assert.match(result.output, /Unlock of the current repository completed/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(currentRun, 'status.json'), 'utf8')).state, 'abandoned');
  assert.equal(JSON.parse(fs.readFileSync(path.join(otherRun, 'status.json'), 'utf8')).state, 'running');
  assert.doesNotMatch(result.output, /other-run/);
});

test('unlock --all acts on every project in the store', (t) => {
  const root = fixture(t);
  const alpha = makeRun(root, 'alpha', 'alpha-run', { state: 'running', pid: DEAD_PID });
  const beta = makeRun(root, 'beta', 'beta-run', { state: 'running', pid: DEAD_PID });

  const result = unlock(['--all'], { runsRootPath: root });

  assert.equal(result.exitCode, 0);
  assert.match(result.output, /Unlock of all projects completed/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(alpha, 'status.json'), 'utf8')).state, 'abandoned');
  assert.equal(JSON.parse(fs.readFileSync(path.join(beta, 'status.json'), 'utf8')).state, 'abandoned');
});

test('unlock is idempotent and reports a clean store as success', (t) => {
  const root = fixture(t);
  const run = '2026-08-06_204009_idempotent';
  makeRun(root, 'alpha', run, { state: 'running', pid: DEAD_PID, agent: 'codex-build' });

  const first = unlock(['--all'], { runsRootPath: root });
  const second = unlock(['--all'], { runsRootPath: root });

  assert.equal(first.exitCode, 0);
  assert.match(first.output, /Closed 1 running record/);
  assert.equal(second.exitCode, 0);
  assert.match(second.output, /Nothing to close; the store is unchanged/);
  assert.match(second.output, /stale heartbeats left untouched: none/);

  const cleanRoot = fixture(t);
  const clean = unlock(['--all'], { runsRootPath: cleanRoot });
  assert.equal(clean.exitCode, 0);
  assert.match(clean.output, /Nothing to close; the store is unchanged/);
});
