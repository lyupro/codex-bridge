/** Verifies that a repeated call joins the run its order already has instead of starting another. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { attach } from '../../src/runner/attach.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/**
 * A pid that is certainly gone: a process this test waited for. A made-up number is not the
 * same test — the operating system is free to have handed it to someone else.
 */
function deadPid() {
  return spawnSync(process.execPath, ['-e', '0']).pid;
}

function run(runsRoot, name, status, files = {}) {
  const dir = path.join(runsRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'status.json'), `${JSON.stringify(status, null, 2)}\n`);
  for (const [file, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), body);
  return dir;
}

const running = (repo, overrides = {}) => ({
  state: 'running',
  pid: process.pid,
  agent: 'codex-build',
  slug: 'async-start',
  order_id: 'order-1',
  repo,
  started_at: '2026-08-04T09:00:00.000Z',
  ...overrides,
});

const order = (runsRoot, repo, overrides = {}) => ({
  runsRoot,
  repo,
  slug: 'async-start',
  taskHash: 'hash-1',
  orderId: 'order-1',
  ...overrides,
});

/** Runs attach() with console.log captured, so the printed contract can be asserted too. */
async function attaching(args) {
  const lines = [];
  const original = console.log;
  console.log = (...parts) => lines.push(parts.join(' '));
  try {
    return { code: await attach(args), lines };
  } finally {
    console.log = original;
  }
}

test('an order with no runs at all starts one', async (t) => {
  const runsRoot = fixture(t);
  const repo = path.join(runsRoot, 'repo');

  const { code } = await attaching(order(runsRoot, repo));

  assert.equal(code, null);
});

test('a live run of the same order is joined and its verdict printed', async (t) => {
  const runsRoot = fixture(t);
  const repo = path.join(runsRoot, 'repo');
  const dir = run(runsRoot, '2026-08-04_090000_async-start', running(repo), {
    'reply.txt': 'OK — the work landed\nRun: somewhere\n',
    'meta.json': JSON.stringify({ status: 'OK' }),
  });

  const { code, lines } = await attaching(order(runsRoot, repo));

  assert.equal(code, 0);
  assert.equal(lines[0], `ATTACH=${dir} started=2026-08-04T09:00:00.000Z`);
  assert.match(lines[1], /OK — the work landed/);
});

test('the exit code of an attach is the verdict of the run it joined', async (t) => {
  const runsRoot = fixture(t);
  const repo = path.join(runsRoot, 'repo');
  run(runsRoot, '2026-08-04_090000_async-start', running(repo), {
    'reply.txt': 'LIMIT — quota window exhausted\n',
    'meta.json': JSON.stringify({ status: 'LIMIT' }),
  });

  const { code } = await attaching(order(runsRoot, repo));

  assert.equal(code, 3);
});

test('a run that already answered replies from disk rather than refusing the repeat', async (t) => {
  const runsRoot = fixture(t);
  const repo = path.join(runsRoot, 'repo');
  run(runsRoot, '2026-08-04_090000_async-start', running(repo, { state: 'finished', pid: deadPid() }), {
    'meta.json': JSON.stringify({ status: 'OK' }),
    'reply.txt': 'OK — done\n',
  });

  const { code, lines } = await attaching(order(runsRoot, repo));

  assert.equal(code, 0);
  assert.match(lines[1], /OK — done/);
});

test('--continue never attaches: the orchestrator asked for another pass', async (t) => {
  const runsRoot = fixture(t);
  const repo = path.join(runsRoot, 'repo');
  run(runsRoot, '2026-08-04_090000_async-start', running(repo), {
    'meta.json': JSON.stringify({ status: 'OK' }),
    'reply.txt': 'OK — the first pass\n',
  });

  const { code } = await attaching(order(runsRoot, repo, { isContinue: true }));

  assert.equal(code, null);
});

test('a verdict written before the reply still answers the repeat', async (t) => {
  const runsRoot = fixture(t);
  const repo = path.join(runsRoot, 'repo');
  // The window the artifact order opens: meta.json exists, reply.txt does not, the worker is
  // still closing the run. Judged by meta.json this repeat would be refused instead of waited on.
  const dir = run(runsRoot, '2026-08-04_090000_async-start', running(repo), {
    'meta.json': JSON.stringify({ status: 'OK' }),
  });
  const closing = setTimeout(() => fs.writeFileSync(path.join(dir, 'reply.txt'), 'OK — closed late\n'), 50);
  t.after(() => clearTimeout(closing));

  const { code, lines } = await attaching(order(runsRoot, repo));

  assert.equal(code, 0);
  assert.match(lines[1], /OK — closed late/);
});

test('an abandoned run is not joined: a dead pid will never write a reply', async (t) => {
  const runsRoot = fixture(t);
  const repo = path.join(runsRoot, 'repo');
  run(runsRoot, '2026-08-04_090000_async-start', running(repo, { pid: deadPid() }));

  const { code } = await attaching(order(runsRoot, repo));

  assert.equal(code, null);
});

test('a live run carrying another order is left alone', async (t) => {
  const runsRoot = fixture(t);
  const repo = path.join(runsRoot, 'repo');
  run(runsRoot, '2026-08-04_090000_async-start', running(repo, { order_id: 'order-2' }), {
    'reply.txt': 'OK — someone else’s work\n',
    'meta.json': JSON.stringify({ status: 'OK' }),
  });

  const { code } = await attaching(order(runsRoot, repo));

  assert.equal(code, null);
});

test('the same order in another repository is a different run', async (t) => {
  const runsRoot = fixture(t);
  const repo = path.join(runsRoot, 'repo');
  run(runsRoot, '2026-08-04_090000_async-start', running(path.join(runsRoot, 'other-repo')), {
    'reply.txt': 'OK — another tree\n',
    'meta.json': JSON.stringify({ status: 'OK' }),
  });

  const { code } = await attaching(order(runsRoot, repo));

  assert.equal(code, null);
});

test('the oldest live run of an order is joined, so a repeat never fans out', async (t) => {
  const runsRoot = fixture(t);
  const repo = path.join(runsRoot, 'repo');
  const first = run(runsRoot, '2026-08-04_090000_async-start', running(repo), {
    'reply.txt': 'OK — first\n',
    'meta.json': JSON.stringify({ status: 'OK' }),
  });
  run(
    runsRoot,
    '2026-08-04_091500_async-start-2',
    running(repo, { started_at: '2026-08-04T09:15:00.000Z' }),
    { 'reply.txt': 'OK — second\n', 'meta.json': JSON.stringify({ status: 'OK' }) },
  );

  const { lines } = await attaching(order(runsRoot, repo));

  assert.equal(lines[0], `ATTACH=${first} started=2026-08-04T09:00:00.000Z`);
});

test('an attach creates no run folder of its own', async (t) => {
  const runsRoot = fixture(t);
  const repo = path.join(runsRoot, 'repo');
  run(runsRoot, '2026-08-04_090000_async-start', running(repo), {
    'reply.txt': 'OK — the work landed\n',
    'meta.json': JSON.stringify({ status: 'OK' }),
  });

  await attaching(order(runsRoot, repo));

  assert.deepEqual(fs.readdirSync(runsRoot), ['2026-08-04_090000_async-start']);
});
