#!/usr/bin/env node
/**
 * Guards run-state.mjs: status.json, writeFailure, markAbandoned, activeRun,
 * abandonedBranchDrift.
 *   node --test agents/codex-bridge/meta/run-state.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  writeStatus,
  markAbandoned,
  activeRun,
  abandonedBranchDrift,
  writeFailure,
} from '../../src/meta/run-state.mjs';
import { HEARTBEAT_FILE, HEARTBEAT_STALE_MS } from '../../src/heartbeat.mjs';
import { makeChainRoot } from './test-fixtures.mjs';

// A dispatcher pid this OS will never hand out, so pidAlive() reads it as dead everywhere
// these tests run (verified against the real implementation, not assumed).
const DEAD_PID = 999999999;

function setHeartbeatAge(runDir, age) {
  const heartbeat = path.join(runDir, HEARTBEAT_FILE);
  fs.writeFileSync(heartbeat, 'progress\n');
  const at = new Date(Date.now() - age);
  fs.utimesSync(heartbeat, at, at);
}

test('writeFailure() leaves status.json in the failed state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-run-'));
  const { meta } = writeFailure(dir, 'codex-build', 'boom');
  assert.equal(meta.status, 'FAIL');
  const status = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
  assert.equal(status.state, 'failed');
  assert.equal(status.status, 'FAIL');
});

test('writeFailure() can record a refusal that never started Codex', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-run-'));
  const { meta } = writeFailure(dir, 'codex-build', 'Codex was not started', [], true);
  const status = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));

  assert.equal(status.state, 'aborted_pre_start');
  assert.equal(status.status, 'FAIL');
  assert.equal(meta.session_id, null);
  assert.equal(meta.events_bytes, 0);
  assert.equal(meta.stderr_bytes, 0);
});

test('markAbandoned marks a dead, meta-less running run as abandoned', () => {
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runs-'));
  const runDir = path.join(runsRoot, 'run1');
  fs.mkdirSync(runDir);
  writeStatus(runDir, { state: 'running', pid: DEAD_PID, repo: '/repo', agent: 'codex-build' });

  const changed = markAbandoned(runsRoot);

  assert.deepEqual(changed, [{ run: 'run1', state: 'abandoned' }]);
  const status = JSON.parse(fs.readFileSync(path.join(runDir, 'status.json'), 'utf8'));
  assert.equal(status.state, 'abandoned');
  assert.match(status.abandoned_reason, /meta\.json was not recorded/);
});

test('an abandoned run says its tree was never snapshotted either', () => {
  // 2026-07-31_114736 wrote eleven files and left no state-after.txt, so the next pass of
  // that task started from a base that already contained them. The missing verdict was
  // recorded; the missing snapshot was not, and that is what made the later arithmetic lie.
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runs-'));
  const runDir = path.join(runsRoot, 'run-killed');
  fs.mkdirSync(runDir);
  writeStatus(runDir, { state: 'running', pid: DEAD_PID, repo: '/repo', agent: 'codex-build' });

  markAbandoned(runsRoot);

  const status = JSON.parse(fs.readFileSync(path.join(runDir, 'status.json'), 'utf8'));
  assert.equal(status.tree_after, false);
  assert.match(status.abandoned_reason, /post-run worktree state was not captured/);
  assert.match(status.abandoned_reason, /will enter the baseline of the next run/);
});

test('markAbandoned writes a FAIL verdict with the later worktree file list', () => {
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runs-'));
  const runDir = path.join(runsRoot, 'run-files');
  fs.mkdirSync(runDir);
  writeStatus(runDir, { state: 'running', pid: DEAD_PID, repo: '/repo', agent: 'codex-build' });
  fs.writeFileSync(path.join(runDir, 'state-before.txt'), '0\t0\ttracked.txt\nU\t4\told.txt\n');
  const currentTree = '1\t0\ttracked.txt\nU\t4\told.txt\nU\t3\tnew.txt\n';

  markAbandoned(runsRoot, currentTree);

  const meta = JSON.parse(fs.readFileSync(path.join(runDir, 'meta.json'), 'utf8'));
  assert.equal(meta.status, 'FAIL');
  assert.match(meta.reason, /tracked\.txt/);
  assert.match(meta.reason, /new\.txt/);
  assert.match(meta.reason, /later run/);
  assert.match(meta.reason, /not a definitive list/);
  assert.equal(fs.existsSync(path.join(runDir, 'state-after.txt')), false);
});

test('markAbandoned repairs a dead running run that already has a meta.json to finished', () => {
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runs-'));
  const runDir = path.join(runsRoot, 'run2');
  fs.mkdirSync(runDir);
  writeStatus(runDir, { state: 'running', pid: DEAD_PID, repo: '/repo', agent: 'codex-build' });
  const metaText = JSON.stringify({ status: 'OK', finished_at: 'X' });
  fs.writeFileSync(path.join(runDir, 'meta.json'), metaText);

  const changed = markAbandoned(runsRoot);

  assert.deepEqual(changed, [{ run: 'run2', state: 'finished' }]);
  const status = JSON.parse(fs.readFileSync(path.join(runDir, 'status.json'), 'utf8'));
  assert.equal(status.state, 'finished');
  assert.equal(status.status, 'OK');
  assert.equal(status.finished_at, 'X');
  assert.equal(fs.readFileSync(path.join(runDir, 'meta.json'), 'utf8'), metaText);
});

test('markAbandoned keeps a pre-Plan_20 running record without heartbeat alive', () => {
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runs-'));
  const runDir = path.join(runsRoot, 'run3');
  fs.mkdirSync(runDir);
  const before = writeStatus(runDir, { state: 'running', pid: process.pid, repo: '/repo', agent: 'codex-build' });

  const changed = markAbandoned(runsRoot);

  assert.deepEqual(changed, []);
  const status = JSON.parse(fs.readFileSync(path.join(runDir, 'status.json'), 'utf8'));
  assert.deepEqual(status, before);
});

// A stale heartbeat releases the hooks' lock, never this record. Closing a run whose pid still
// lives would make markAbandoned the second writer of its meta.json — the live worker reaches
// collect() afterwards and overwrites the verdict. `stop` closes stalled runs, killing first.
test('markAbandoned leaves a live-pid run alone even when its heartbeat is stale', () => {
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runs-'));
  const runDir = path.join(runsRoot, 'stalled');
  fs.mkdirSync(runDir);
  writeStatus(runDir, { state: 'running', pid: process.pid, repo: '/repo', agent: 'codex-build' });
  setHeartbeatAge(runDir, HEARTBEAT_STALE_MS + 1_000);

  assert.deepEqual(markAbandoned(runsRoot), []);
  const status = JSON.parse(fs.readFileSync(path.join(runDir, 'status.json'), 'utf8'));
  assert.equal(status.state, 'running');
  assert.equal(status.abandoned_reason, undefined);
});

test('activeRun keeps a pre-Plan_20 build run without heartbeat live', () => {
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runs-'));
  const runDir = path.join(runsRoot, 'build-alive');
  fs.mkdirSync(runDir);
  writeStatus(runDir, { state: 'running', pid: process.pid, repo: '/repo/a', agent: 'codex-build' });

  assert.equal(activeRun(runsRoot, '/repo/a'), 'build-alive');
});

// Two writing runs in one worktree is the 2026-08-05 incident. A stalled run still owns the
// tree while its process can wake up; the operator ends it with `stop`, which kills it first.
test('activeRun still refuses a second writing run while the pid lives', () => {
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runs-'));
  const runDir = path.join(runsRoot, 'build-stalled');
  fs.mkdirSync(runDir);
  writeStatus(runDir, { state: 'running', pid: process.pid, repo: '/repo/a', agent: 'codex-build' });
  setHeartbeatAge(runDir, HEARTBEAT_STALE_MS + 1_000);

  assert.equal(activeRun(runsRoot, '/repo/a'), 'build-stalled');
});

test('activeRun ignores a live build run against a different repo', () => {
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runs-'));
  const runDir = path.join(runsRoot, 'build-alive');
  fs.mkdirSync(runDir);
  writeStatus(runDir, { state: 'running', pid: process.pid, repo: '/repo/a', agent: 'codex-build' });

  assert.equal(activeRun(runsRoot, '/repo/zzz'), null);
});

test('activeRun ignores a live scout run when asked about a build', () => {
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runs-'));
  const runDir = path.join(runsRoot, 'scout-alive');
  fs.mkdirSync(runDir);
  writeStatus(runDir, { state: 'running', pid: process.pid, repo: '/repo/a', agent: 'codex-scout' });

  assert.equal(activeRun(runsRoot, '/repo/a'), null);
});

test('activeRun ignores a running entry whose pid is dead', () => {
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runs-'));
  const runDir = path.join(runsRoot, 'build-dead');
  fs.mkdirSync(runDir);
  writeStatus(runDir, { state: 'running', pid: DEAD_PID, repo: '/repo/b', agent: 'codex-build' });

  assert.equal(activeRun(runsRoot, '/repo/b'), null);
});

// One abandoned pass of a build run against /repo/a, which is the only shape this check
// looks at. `state` goes through the fixture rather than a second status.json written on
// top of it: a test that rewrites the fixture's own artifact stops testing the fixture.
const abandonedRoot = (runs) =>
  makeChainRoot(runs.map((run) => ({ repo: '/repo/a', ...run, state: 'abandoned' })));

test('abandoned detached run reports the recorded branch', () => {
  const root = abandonedRoot([{ name: 'abandoned', branchBefore: 'master' }]);
  assert.deepEqual(abandonedBranchDrift(root, '/repo/a', ''), { run: 'abandoned', branch: 'master' });
});

test('abandoned branch drift clears when the repository is back on the branch', () => {
  const root = abandonedRoot([{ name: 'abandoned', branchBefore: 'master' }]);
  assert.equal(abandonedBranchDrift(root, '/repo/a', 'master'), null);
});

test('abandoned branch drift ignores normal work on another branch', () => {
  const root = abandonedRoot([{ name: 'abandoned', branchBefore: 'master' }]);
  assert.equal(abandonedBranchDrift(root, '/repo/a', 'feature'), null);
});

test('abandoned run with an empty branch snapshot is ignored', () => {
  const root = abandonedRoot([{ name: 'abandoned', branchBefore: '' }]);
  assert.equal(abandonedBranchDrift(root, '/repo/a', ''), null);
});

test('finished run with branch artifacts is ignored', () => {
  const root = makeChainRoot([{ name: 'finished', repo: '/repo/a', branchBefore: 'master' }]);
  assert.equal(abandonedBranchDrift(root, '/repo/a', ''), null);
});

test('abandoned run from another repository is ignored', () => {
  const root = abandonedRoot([{ name: 'other', repo: '/repo/b', branchBefore: 'master' }]);
  assert.equal(abandonedBranchDrift(root, '/repo/a', ''), null);
});

test('newest abandoned run wins', () => {
  const root = abandonedRoot([
    { name: 'older', branchBefore: 'master', at: '2026-08-01' },
    { name: 'newer', branchBefore: 'feature', at: '2026-08-02' },
  ]);
  assert.deepEqual(abandonedBranchDrift(root, '/repo/a', ''), { run: 'newer', branch: 'feature' });
});
