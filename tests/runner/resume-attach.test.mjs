/** Plan_80 E13 O6: repeating a resume grant returns the pass that grant already started. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { attaching, fixture, order, run, running } from './attach-fixtures.mjs';

const NAME = '2026-10-03_180200_resume';
const START = '2026-10-03T18:02:00.000Z';

function finished(runsRoot, repo, status = {}, verdict = 'OK') {
  return run(runsRoot, NAME, running(repo, {
    state: 'finished', started_at: START, resumed_from: 'B', ...status,
  }), {
    'meta.json': JSON.stringify({ status: verdict }),
    'reply.txt': `${verdict} — saved resumed verdict\n`,
  });
}

for (const [verdict, exitCode] of [['OK', 0], ['LIMIT', 3]]) {
  test(`a repeated resume returns its saved ${verdict} verdict and provenance`, async (t) => {
    const runsRoot = fixture(t);
    const repo = path.join(runsRoot, 'repo');
    const dir = finished(runsRoot, repo, {}, verdict);
    const { code, lines } = await attaching(order(runsRoot, repo, { isContinue: true, resumeRun: 'B' }));
    assert.equal(code, exitCode);
    assert.equal(lines[0], `ATTACH=${dir} order-id=order-1 started=${START}`);
    assert.equal(lines[1], `This is the answer of the previous run started at ${START}; no new work was started.`);
    assert.equal(lines[2], `${verdict} — saved resumed verdict`);
  });
}

test('resume matches equivalent run paths through sameRun', async (t) => {
  const runsRoot = fixture(t);
  const repo = path.join(runsRoot, 'repo');
  finished(runsRoot, repo, { resumed_from: path.join(runsRoot, 'B') });
  const { code } = await attaching(order(runsRoot, repo, { isContinue: true, resumeRun: 'B' }));
  assert.equal(code, 0);
});

for (const [label, status, selectors] of [
  ['another resume source', { resumed_from: 'C' }, { resumeRun: 'B' }],
  ['only retry_of', { resumed_from: undefined, retry_of: 'B' }, { resumeRun: 'B' }],
  ['only resumed_from', {}, { retryRun: 'B' }],
  ['another order', { order_id: 'other-order' }, { resumeRun: 'B' }],
  ['continued_from without resumed_from', { resumed_from: undefined, continued_from: 'B' }, { resumeRun: 'B' }],
]) {
  test(`a continue call does not attach to ${label}`, async (t) => {
    const runsRoot = fixture(t);
    const repo = path.join(runsRoot, 'repo');
    finished(runsRoot, repo, status);
    const { code, lines } = await attaching(order(runsRoot, repo, { isContinue: true, ...selectors }));
    assert.equal(code, null);
    assert.deepEqual(lines, []);
  });
}

test('a resume grant with no candidate returns null', async (t) => {
  const runsRoot = fixture(t);
  const repo = path.join(runsRoot, 'repo');
  const { code, lines } = await attaching(order(runsRoot, repo, { isContinue: true, resumeRun: 'B' }));
  assert.equal(code, null);
  assert.deepEqual(lines, []);
});
