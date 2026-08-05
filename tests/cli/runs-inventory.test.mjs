/** Verifies run-store discovery, measurements, fallback facts, and liveness. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listProjectRuns, listProjects, recursiveSize } from '../../cli/runs-inventory.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-inventory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value));
}

function makeRun(root, project, run, files = {}) {
  const dir = path.join(root, project, run);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), value);
  }
  return dir;
}

test('lists one measured summary per project and marks live runs', (t) => {
  const root = fixture(t);
  const finished = makeRun(root, 'alpha', '2026-08-04_090000_first', {
    'meta.json': JSON.stringify({
      agent: 'alpha-agent',
      status: 'PASS',
      tokens: 12,
      finished_at: '2026-08-04T09:00:00.000Z',
    }),
    'payload.txt': 'payload',
  });
  makeRun(root, 'alpha', '2026-08-05_090000_second', {
    'meta.json': JSON.stringify({
      agent: 'alpha-agent',
      status: 'FAIL',
      tokens: 8,
      finished_at: '2026-08-05T09:00:00.000Z',
    }),
  });
  const live = makeRun(root, 'beta', '2026-08-06_090000_live', {
    'meta.json': JSON.stringify({ agent: 'beta-agent', status: 'PASS', tokens: 3 }),
    'status.json': JSON.stringify({
      state: 'running',
      pid: process.pid,
      agent: 'beta-agent',
      slug: 'live',
      repo: root,
    }),
  });

  const rows = listProjects(root);

  assert.deepEqual(rows.map((row) => row.project), ['alpha', 'beta']);
  assert.deepEqual(rows[0], {
    project: 'alpha',
    runs: 2,
    size: recursiveSize(path.join(root, 'alpha')),
    totalTokens: 20,
    liveNow: 0,
    lastRun: '2026-08-05T09:00:00.000Z',
  });
  assert.deepEqual(rows[1], {
    project: 'beta',
    runs: 1,
    size: recursiveSize(path.join(root, 'beta')),
    totalTokens: 3,
    liveNow: 1,
    lastRun: '2026-08-06_090000',
  });
  assert.equal(recursiveSize(finished), fs.statSync(path.join(finished, 'meta.json')).size
    + fs.statSync(path.join(finished, 'payload.txt')).size);
  assert.equal(fs.existsSync(live), true);
});

test('uses status facts when meta is missing and keeps unreadable runs as unknown rows', (t) => {
  const root = fixture(t);
  makeRun(root, 'legacy', '2026-08-05_110000_fallback', {
    'status.json': JSON.stringify({
      state: 'finished',
      agent: 'legacy-agent',
      started_at: '2026-08-05T11:00:00.000Z',
    }),
  });
  const damaged = makeRun(root, 'legacy', '2026-08-05_120000_damaged', {
    'meta.json': '{not json',
    'status.json': '[not an object]',
  });

  const rows = listProjectRuns(root, 'legacy');

  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    run: '2026-08-05_110000_fallback',
    agent: 'legacy-agent',
    verdict: 'finished',
    tokens: null,
    size: recursiveSize(path.join(root, 'legacy', '2026-08-05_110000_fallback')),
    live: false,
  });
  assert.deepEqual(rows[1], {
    run: '2026-08-05_120000_damaged',
    agent: null,
    verdict: null,
    tokens: null,
    size: recursiveSize(damaged),
    live: false,
  });
});

test('returns null for an unknown project without throwing', (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'known'), { recursive: true });

  assert.equal(listProjectRuns(root, 'missing'), null);
});
