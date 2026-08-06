/** Verifies automatic cleanup is narrow, date-based, live-run safe, and best effort. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanupRetention } from '../src/retention.mjs';
import { readRunConfig } from '../src/run-config.mjs';

const NOW = Date.parse('2026-08-06T12:00:00.000Z');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function makeRun(root, name, files = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), content);
  return dir;
}

function status(runDir, value) {
  fs.writeFileSync(path.join(runDir, 'status.json'), `${JSON.stringify(value)}\n`);
}

test('old runs lose only regular transport files and keep metadata and directories', (t) => {
  const root = fixture(t);
  const old = makeRun(root, '2026-07-01_090000_old', {
    'events.jsonl': 'events',
    'stderr.log': 'stderr',
    'meta.json': '{}',
    'status.json': '{}',
  });
  fs.mkdirSync(path.join(old, 'raw.log'));
  fs.writeFileSync(path.join(old, 'raw.log', 'nested.txt'), 'keep');
  const recent = makeRun(root, '2026-08-06_110000_recent', { 'events.jsonl': 'recent' });
  const undated = makeRun(root, 'manual-run', { 'events.jsonl': 'manual' });

  const result = cleanupRetention(root, { enabled: true, days: 30 }, { now: NOW });

  assert.deepEqual(result, {
    bytes_freed: Buffer.byteLength('events') + Buffer.byteLength('stderr'),
    runs: 1,
    days: 30,
  });
  for (const file of ['events.jsonl', 'stderr.log']) assert.equal(fs.existsSync(path.join(old, file)), false);
  assert.equal(fs.existsSync(path.join(old, 'meta.json')), true);
  assert.equal(fs.existsSync(path.join(old, 'status.json')), true);
  assert.equal(fs.existsSync(path.join(old, 'raw.log', 'nested.txt')), true);
  assert.equal(fs.existsSync(old), true);
  assert.equal(fs.existsSync(path.join(recent, 'events.jsonl')), true);
  assert.equal(fs.existsSync(path.join(undated, 'events.jsonl')), true);
});

test('a live old run is skipped by the pid probe, even with running status', (t) => {
  const root = fixture(t);
  const live = makeRun(root, '2026-01-01_090000_live', { 'events.jsonl': 'live' });
  status(live, {
    state: 'running',
    pid: process.pid,
    agent: 'codex-build',
    slug: 'live',
    repo: root,
  });

  const result = cleanupRetention(root, { enabled: true, days: 30 }, { now: NOW });

  assert.equal(result, null);
  assert.equal(fs.existsSync(path.join(live, 'events.jsonl')), true);
});

test('disabled cleanup does nothing without reading its day count', (t) => {
  const root = fixture(t);
  const run = makeRun(root, '2026-01-01_090000_disabled', { 'events.jsonl': 'keep' });
  const config = { enabled: false };
  Object.defineProperty(config, 'days', { get() { throw new Error('days must not be read'); } });

  assert.equal(cleanupRetention(root, config, { now: NOW }), null);
  assert.equal(fs.existsSync(path.join(run, 'events.jsonl')), true);
});

test('retention configuration refuses malformed enabled values but ignores disabled days', (t) => {
  const root = fixture(t);
  const file = path.join(root, 'run-config.json');
  fs.writeFileSync(file, JSON.stringify({ retention: { enabled: false, days: 'ignored' } }));
  assert.deepEqual(readRunConfig(file).retention, { enabled: false });

  fs.writeFileSync(file, JSON.stringify({ retention: { enabled: 'yes', days: 30 } }));
  assert.throws(() => readRunConfig(file), /retention\.enabled.*true or false/);
  fs.writeFileSync(file, JSON.stringify({ retention: { enabled: true, days: 0 } }));
  assert.throws(() => readRunConfig(file), /retention\.days.*positive number/);
});

test('a throwing filesystem is swallowed so startup can continue', (t) => {
  const root = fixture(t);
  const throwingFs = { readdirSync() { throw new Error('filesystem unavailable'); } };

  assert.doesNotThrow(() => cleanupRetention(root, { enabled: true, days: 30 }, { fs: throwingFs, now: NOW }));
});
