/** Verifies the shared heartbeat's throttle, age, and legacy-record policy. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createHeartbeat,
  heartbeatAge,
  heartbeatPath,
  isHeartbeatFresh,
  HEARTBEAT_STALE_MS,
  HEARTBEAT_WRITE_INTERVAL_MS,
} from '../src/heartbeat.mjs';

function runDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-heartbeat-'));
}

test('heartbeat stamps are throttled so a large stream does not write per chunk', () => {
  const dir = runDir();
  const heartbeat = createHeartbeat(dir);
  heartbeat.stamp(1_000);
  heartbeat.stamp(1_001);
  assert.equal(fs.readFileSync(heartbeatPath(dir), 'utf8'), '1000\n');
  heartbeat.stamp(1_000 + HEARTBEAT_WRITE_INTERVAL_MS);
  assert.equal(fs.readFileSync(heartbeatPath(dir), 'utf8'), `${1_000 + HEARTBEAT_WRITE_INTERVAL_MS}\n`);
});

test('heartbeat write failures are non-fatal to the run', () => {
  const heartbeat = createHeartbeat(path.join(os.tmpdir(), 'missing-heartbeat-parent', 'run'));
  assert.doesNotThrow(() => heartbeat.stamp());
});

test('missing heartbeat is an explicit legacy-live state while old pid is still present', () => {
  const dir = runDir();
  assert.equal(heartbeatAge(dir), null);
  assert.equal(isHeartbeatFresh(dir), true);
});

test('heartbeat age becomes stale only beyond the five-minute safety margin', () => {
  const dir = runDir();
  const heartbeat = createHeartbeat(dir);
  const now = Date.now();
  heartbeat.stamp(now);
  const at = new Date(now);
  fs.utimesSync(heartbeatPath(dir), at, at);
  assert.equal(isHeartbeatFresh(dir, now + HEARTBEAT_STALE_MS - 1), true);
  assert.equal(isHeartbeatFresh(dir, now + HEARTBEAT_STALE_MS + 1), false);
});
