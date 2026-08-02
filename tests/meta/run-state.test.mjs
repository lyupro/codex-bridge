#!/usr/bin/env node
/**
 * Guards run-state.mjs: status.json, writeFailure, markAbandoned, activeRun.
 *   node --test agents/codex/meta/run-state.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeStatus, markAbandoned, activeRun, writeFailure } from '../../src/meta/run-state.mjs';

// A dispatcher pid this OS will never hand out, so pidAlive() reads it as dead everywhere
// these tests run (verified against the real implementation, not assumed).
const DEAD_PID = 999999999;

test('writeFailure() leaves status.json in the failed state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-run-'));
  const { meta } = writeFailure(dir, 'codex-build', 'boom');
  assert.equal(meta.status, 'FAIL');
  const status = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
  assert.equal(status.state, 'failed');
  assert.equal(status.status, 'FAIL');
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

test('markAbandoned repairs a dead running run that already has a meta.json to finished', () => {
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runs-'));
  const runDir = path.join(runsRoot, 'run2');
  fs.mkdirSync(runDir);
  writeStatus(runDir, { state: 'running', pid: DEAD_PID, repo: '/repo', agent: 'codex-build' });
  fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify({ status: 'OK', finished_at: 'X' }));

  const changed = markAbandoned(runsRoot);

  assert.deepEqual(changed, [{ run: 'run2', state: 'finished' }]);
  const status = JSON.parse(fs.readFileSync(path.join(runDir, 'status.json'), 'utf8'));
  assert.equal(status.state, 'finished');
  assert.equal(status.status, 'OK');
  assert.equal(status.finished_at, 'X');
});

test('markAbandoned leaves a running run alone while its pid is alive', () => {
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runs-'));
  const runDir = path.join(runsRoot, 'run3');
  fs.mkdirSync(runDir);
  const before = writeStatus(runDir, { state: 'running', pid: process.pid, repo: '/repo', agent: 'codex-build' });

  const changed = markAbandoned(runsRoot);

  assert.deepEqual(changed, []);
  const status = JSON.parse(fs.readFileSync(path.join(runDir, 'status.json'), 'utf8'));
  assert.deepEqual(status, before);
});

test('activeRun finds a live build run against the same repo', () => {
  const runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-runs-'));
  const runDir = path.join(runsRoot, 'build-alive');
  fs.mkdirSync(runDir);
  writeStatus(runDir, { state: 'running', pid: process.pid, repo: '/repo/a', agent: 'codex-build' });

  assert.equal(activeRun(runsRoot, '/repo/a'), 'build-alive');
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
