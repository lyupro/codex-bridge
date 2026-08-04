/** Verifies that a repeated call joins the run its order already has instead of starting another. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { attach } from '../../src/runner/attach.mjs';
import { continuationRefusal } from '../../src/runner/launcher.mjs';

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

test('the first --continue is allowed after exactly one finished run', (t) => {
  const runsRoot = fixture(t);
  const repo = path.join(runsRoot, 'repo');
  const name = '2026-08-04_090000_async-start';
  run(runsRoot, name, running(repo, { state: 'finished', pid: deadPid() }), {
    'meta.json': JSON.stringify({ status: 'LIMIT' }),
  });

  assert.equal(continuationRefusal(runsRoot, [name], true, 'order-1'), null);
});

test('a second --continue names the runs already spent and requires a new order id', (t) => {
  const runsRoot = fixture(t);
  const repo = path.join(runsRoot, 'repo');
  const first = '2026-08-04_090000_async-start';
  const second = '2026-08-04_091500_async-start-2';
  for (const name of [first, second]) {
    run(runsRoot, name, running(repo, { state: 'finished', pid: deadPid() }), {
      'meta.json': JSON.stringify({ status: 'FAIL' }),
    });
  }

  const message = continuationRefusal(runsRoot, [first, second], true, 'order-1');

  assert.match(message, new RegExp(first));
  assert.match(message, new RegExp(second));
  assert.match(message, /new order id from the orchestrator/);
});

/**
 * The escape hatch the refusal itself points at has to actually work. The chain also matches runs
 * by the task fingerprint, so a fresh order id lands in the same chain — counted over the chain
 * rather than over the order, a task would be refused with --continue and refused without it.
 */
test('a fresh order id is not charged for the runs of the previous one', (t) => {
  const runsRoot = fixture(t);
  const repo = path.join(runsRoot, 'repo');
  const first = '2026-08-04_090000_async-start';
  const second = '2026-08-04_091500_async-start-2';
  for (const name of [first, second]) {
    run(runsRoot, name, running(repo, { state: 'finished', pid: deadPid() }), {
      'meta.json': JSON.stringify({ status: 'FAIL' }),
    });
  }

  assert.equal(continuationRefusal(runsRoot, [first, second], true, 'order-2'), null);
});

test('--continue behind a run without a verdict is refused before another folder is made', (t) => {
  const runsRoot = fixture(t);
  const repo = path.join(runsRoot, 'repo');
  const name = '2026-08-04_090000_async-start';
  run(runsRoot, name, running(repo));

  const message = continuationRefusal(runsRoot, [name], true, 'order-1');

  assert.match(message, /no finished verdict/);
  assert.match(message, /Repeat without --continue to attach/);
  assert.deepEqual(fs.readdirSync(runsRoot), [name]);
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

// An order gets a second run when the orchestrator spends its one --continue. Answering a repeat
// from the earlier run — which is what happened until 2026-08-04 — hands back the previous pass's
// verdict as if it were this one's, and the caller has no way to tell.
test('the newest run of an order answers the repeat, not the pass before it', async (t) => {
  const runsRoot = fixture(t);
  const repo = path.join(runsRoot, 'repo');
  run(runsRoot, '2026-08-04_090000_async-start', running(repo), {
    'reply.txt': 'OK — first\n',
    'meta.json': JSON.stringify({ status: 'OK' }),
  });
  const second = run(
    runsRoot,
    '2026-08-04_091500_async-start-2',
    running(repo, { started_at: '2026-08-04T09:15:00.000Z' }),
    { 'reply.txt': 'OK — second\n', 'meta.json': JSON.stringify({ status: 'OK' }) },
  );

  const { lines } = await attaching(order(runsRoot, repo));

  assert.equal(lines[0], `ATTACH=${second} started=2026-08-04T09:15:00.000Z`);
  assert.equal(lines[1], 'OK — second');
});

test('a continuation still running is joined instead of the answered pass before it', async (t) => {
  const runsRoot = fixture(t);
  const repo = path.join(runsRoot, 'repo');
  run(runsRoot, '2026-08-04_090000_async-start', running(repo), {
    'reply.txt': 'OK — first\n',
    'meta.json': JSON.stringify({ status: 'OK' }),
  });
  const second = run(
    runsRoot,
    '2026-08-04_091500_async-start-2',
    running(repo, { started_at: '2026-08-04T09:15:00.000Z', pid: process.pid }),
  );
  setTimeout(() => {
    fs.writeFileSync(path.join(second, 'meta.json'), JSON.stringify({ status: 'OK' }));
    fs.writeFileSync(path.join(second, 'reply.txt'), 'OK — the continuation\n');
  }, 60);

  const { lines } = await attaching(order(runsRoot, repo));

  assert.equal(lines[0], `ATTACH=${second} started=2026-08-04T09:15:00.000Z`);
  assert.equal(lines[1], 'OK — the continuation');
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
