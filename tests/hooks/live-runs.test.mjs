/** Verifies the hook-side definition of a live run: pid plus a fresh progress heartbeat. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { liveRuns, RECENT_RUN_MAX_AGE_MS, recentRuns } from '../../src/home/hooks/live-runs.mjs';
import { HEARTBEAT_FILE, HEARTBEAT_STALE_MS } from '../../src/home/lib/heartbeat.mjs';

function makeRun() {
  const runs = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-live-runs-'));
  const dir = path.join(runs, 'run1');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'status.json'), `${JSON.stringify({
    state: 'running',
    pid: process.pid,
    agent: 'codex-build',
    slug: 'heartbeat-test',
    repo: '/repo',
  })}\n`);
  return { runs, dir };
}

function setHeartbeatAge(dir, age) {
  const heartbeat = path.join(dir, HEARTBEAT_FILE);
  fs.writeFileSync(heartbeat, 'progress\n');
  const at = new Date(Date.now() - age);
  fs.utimesSync(heartbeat, at, at);
}

test('a live pid with a stale heartbeat is not live to the hooks', () => {
  const { runs, dir } = makeRun();
  setHeartbeatAge(dir, HEARTBEAT_STALE_MS + 1_000);
  assert.deepEqual(liveRuns(runs), []);
});

test('a live pid with a heartbeat below the threshold stays live during silence', () => {
  const { runs, dir } = makeRun();
  setHeartbeatAge(dir, HEARTBEAT_STALE_MS - 1_000);
  assert.equal(liveRuns(runs).length, 1);
});

test('a pre-Plan_20 running record without a heartbeat keeps its lock', () => {
  const { runs } = makeRun();
  assert.equal(liveRuns(runs).length, 1);
});

test('strict live scans exclude a run whose process identity is unconfirmed', () => {
  const { runs } = makeRun();
  assert.deepEqual(liveRuns(runs, { requireConfirmedIdentity: true }), []);
});

test('recent scans include finished runs and filter by agent and age', () => {
  const now = Date.now();
  const { runs, dir } = makeRun();
  fs.writeFileSync(path.join(dir, 'status.json'), `${JSON.stringify({
    state: 'finished',
    status: 'OK',
    agent: 'codex-build',
    slug: 'recent-finished',
    repo: '/repo',
    finished_at: new Date(now - 1_000).toISOString(),
  })}\n`);
  const other = path.join(runs, 'other-agent');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'status.json'), JSON.stringify({
    state: 'finished',
    agent: 'codex-review',
    finished_at: new Date(now - 500).toISOString(),
  }));
  const stale = path.join(runs, 'stale');
  fs.mkdirSync(stale);
  fs.writeFileSync(path.join(stale, 'status.json'), JSON.stringify({
    state: 'finished',
    agent: 'codex-build',
    finished_at: new Date(now - RECENT_RUN_MAX_AGE_MS - 1).toISOString(),
  }));
  assert.deepEqual(recentRuns(runs, { agent: 'codex-build', now }).map((run) => run.dir), [dir]);
});

test('recent scans report unreadable JSON as uncertainty', () => {
  const { runs, dir } = makeRun();
  fs.writeFileSync(path.join(dir, 'status.json'), '{ broken');
  assert.equal(recentRuns(runs, { agent: 'codex-build' }), null);
});
