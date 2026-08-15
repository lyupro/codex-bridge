/**
 * Verifies the state-only call: --no-wait answers from disk and never waits, never starts a run.
 *
 * The outcome exists because 2026-08-13 had no third answer. A waiting call was killed, and the
 * dispatcher — left with "wait the whole run again" or "make something up" — announced
 * `FAIL — не удалось получить результат прогона Codex` over a run whose status.json already said
 * finished/OK. Code 4 is that missing third answer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { attaching, fixture, order, run, running } from './attach-fixtures.mjs';

test('--no-wait prints a ready reply with the existing provenance and status code', async (t) => {
  const runsRoot = fixture(t);
  const repo = path.join(runsRoot, 'repo');
  const dir = run(runsRoot, '2026-08-04_090000_async-start', running(repo), {
    'reply.txt': 'LIMIT — quota exhausted\nRun: somewhere\n',
    'meta.json': JSON.stringify({ status: 'LIMIT' }),
  });

  const { code, lines } = await attaching(order(runsRoot, repo, { noWait: true }));

  assert.equal(code, 3);
  assert.equal(lines[0], `ATTACH=${dir} order-id=order-1 started=2026-08-04T09:00:00.000Z`);
  assert.match(lines[1], /previous run started at 2026-08-04T09:00:00.000Z; no new work was started/);
  assert.equal(lines[2], 'LIMIT — quota exhausted\nRun: somewhere');
});

test('--no-wait reports a live run immediately with call outcome 4', async (t) => {
  const runsRoot = fixture(t);
  const repo = path.join(runsRoot, 'repo');
  const startedAt = new Date(Date.now() - 65_000).toISOString();
  const worker = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 750)']);
  t.after(() => worker.kill());
  const dir = run(runsRoot, '2026-08-04_090000_async-start',
    running(repo, { pid: worker.pid, started_at: startedAt }), { heartbeat: `${Date.now()}\n` });

  const before = Date.now();
  const { code, lines } = await attaching(order(runsRoot, repo, { noWait: true }));

  assert.equal(code, 4);
  assert.ok(Date.now() - before < 450, 'the state check must not enter the 500 ms polling loop');
  assert.equal(lines[0], `ATTACH=${dir} order-id=order-1 started=${startedAt}`);
  // The elapsed value is matched by shape, not to the second: pinning it to a one-second window
  // made the case fail whenever the identity probe took longer than that under a loaded suite.
  assert.match(lines[1], /Run is still in progress; elapsed 1m \d{1,2}s\./);
  assert.match(lines[1], /Repeat the same command without --no-wait later to wait for its verdict/);
});

test('--no-wait reports a missing order with call outcome 4', async (t) => {
  const runsRoot = fixture(t);
  const repo = path.join(runsRoot, 'repo');

  const { code, lines } = await attaching(order(runsRoot, repo, { noWait: true }));

  assert.equal(code, 4);
  assert.deepEqual(lines, ['No run exists for order id "order-1"; --no-wait never starts a new run.']);
  assert.deepEqual(fs.readdirSync(runsRoot), []);
});
