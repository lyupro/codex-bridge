/** Guards repeats that attach only to the continuation named by their grant. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { attaching, deadPid, fixture, order, run, running } from './attach-fixtures.mjs';

const GRANT_RUN = '2026-09-23_140000_prior-pass';

test('a live same-order continuation is joined and its verdict is printed', async (t) => {
  const runsRoot = fixture(t);
  const repo = path.join(runsRoot, 'repo');
  const continuation = '2026-09-23_141341_plan59-a1-stdin-hang';
  const dir = run(runsRoot, continuation, running(repo, { continued_from: GRANT_RUN }));
  const answering = setTimeout(() => {
    fs.writeFileSync(path.join(dir, 'meta.json'), '{"status":"OK"}');
    fs.writeFileSync(path.join(dir, 'reply.txt'), 'OK — continuation verdict\n');
  }, 50);
  t.after(() => clearTimeout(answering));

  const { code, lines } = await attaching(
    order(runsRoot, repo, { isContinue: true, grantRun: GRANT_RUN }),
  );

  assert.equal(code, 0);
  assert.match(lines[1], /run already in progress/);
  assert.equal(lines[2], 'OK — continuation verdict');
});

test('a continuation with a saved reply answers from disk', async (t) => {
  const runsRoot = fixture(t);
  const repo = path.join(runsRoot, 'repo');
  const dir = run(
    runsRoot,
    '2026-09-23_141341_plan59-a1-stdin-hang',
    running(repo, { continued_from: GRANT_RUN, state: 'finished', pid: deadPid() }),
    { 'meta.json': '{"status":"OK"}', 'reply.txt': 'OK — saved continuation\n' },
  );

  const { code, lines } = await attaching(
    order(runsRoot, repo, { isContinue: true, grantRun: GRANT_RUN }),
  );

  assert.equal(code, 0);
  assert.equal(lines[0], `ATTACH=${dir} order-id=order-1 started=2026-08-04T09:00:00.000Z`);
  assert.match(lines[1], /previous run started at/);
  assert.equal(lines[2], 'OK — saved continuation');
});

test('a continuation with another order id is not joined for this grant', async (t) => {
  const runsRoot = fixture(t);
  const repo = path.join(runsRoot, 'repo');
  const other = run(
    runsRoot,
    '2026-09-23_141341_other-order',
    running(repo, { order_id: 'order-2', continued_from: GRANT_RUN }),
    { 'meta.json': '{"status":"OK"}', 'reply.txt': 'OK — other order\n' },
  );

  const { code, lines } = await attaching(
    order(runsRoot, repo, {
      chain: [path.basename(other)],
      isContinue: true,
      grantRun: GRANT_RUN,
    }),
  );

  assert.equal(code, null);
  assert.deepEqual(lines, []);
});
