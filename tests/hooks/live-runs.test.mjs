/** Verifies the hook-side definition of a live run: pid plus a fresh progress heartbeat. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { liveRuns } from '../../src/hooks/live-runs.mjs';
import { HEARTBEAT_FILE, HEARTBEAT_STALE_MS } from '../../src/heartbeat.mjs';

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
