/** OW-074 C3: capacity replies must not offer a grant back into the overloaded thread. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { collect } from '../../src/home/lib/write-meta.mjs';
import { capacityReply, limitReply } from '../../src/home/lib/meta/reply.mjs';
import { buildResult, makeRun } from './test-fixtures.mjs';

const fixture = fs.readFileSync(
  new URL('./fixtures/codex-0.160-model-capacity.events.jsonl', import.meta.url),
  'utf8',
);
const firstRow = 'CAPACITY — selected model is at capacity; work not completed';
const actionRow = "Action: wait or change this role's model (/codex-bridge:model), then repeat the order once with a retry: grant; a second CAPACITY goes to the next executor";

function assertNoContinuation(rows) {
  assert.equal(rows.some((row) => /^(?:resume:|retry:|continue:|Continuation:|Situation:)/.test(row)), false);
}

test('a build capacity reply names the signal and action, then the worktree and log', () => {
  const dir = makeRun({ events: fixture });
  const { meta, reply } = collect(dir, 'codex-build', 1);
  const rows = reply.split('\n');

  assert.equal(meta.status, 'CAPACITY');
  assert.equal(rows[0], firstRow);
  assert.match(rows[1], /^Signal: .*Selected model is at capacity/);
  assert.equal(rows[2], actionRow);
  assert.equal(rows[3], 'Worktree: no new changes');
  assert.equal(rows.at(-1), `Log: codex-bridge read ${dir}`);
  assert.equal(rows.length, 5);
  assertNoContinuation(rows);
});

test('a scout capacity reply has no worktree or continuation rows', () => {
  const dir = makeRun({ events: fixture });
  const { meta, reply } = collect(dir, 'codex-scout', 1);
  const rows = reply.split('\n');

  assert.equal(meta.status, 'CAPACITY');
  assert.deepEqual(rows, [firstRow, `Signal: ${meta.reason}`, actionRow, `Log: codex-bridge read ${dir}`]);
  assert.equal(rows.some((row) => row.startsWith('Worktree:')), false);
  assertNoContinuation(rows);
});

test('capacity reuses the LIMIT worktree row and cuts the signal', () => {
  const dir = makeRun({ events: fixture });
  const ctx = { runDir: dir, agent: 'codex-build' };
  const meta = { reason: 'x'.repeat(200) };
  const rows = capacityReply(ctx, meta);

  assert.equal(rows[1], limitReply(ctx, meta)[1]);
  assert.ok(rows[1].length <= 'Signal: '.length + 170);
  assert.equal(rows[3], 'Worktree: no new changes');
  assert.equal(rows[3], limitReply(ctx, meta)[2]);
  assert.equal(rows.at(-1), `Log: codex-bridge read ${dir}`);
  assertNoContinuation(rows);
});

test('the existing profile wrapper adds exactly one model row before the capacity log', () => {
  const dir = makeRun({ events: fixture });
  fs.writeFileSync(path.join(dir, 'worker.json'), JSON.stringify({
    profile: { model: 'test-model', effort: 'high', effort_source: 'order' },
  }), 'utf8');
  const rows = collect(dir, 'codex-build', 1).reply.split('\n');

  assert.equal(rows[0], firstRow);
  assert.equal(rows.filter((row) => row.startsWith('Model:')).length, 1);
  assert.equal(rows.at(-2), 'Model: test-model at high effort (order)');
  assert.equal(rows.at(-1), `Log: codex-bridge read ${dir}`);
  assertNoContinuation(rows);
});

test('a non-capacity reconnect failure still renders FAIL', () => {
  const dir = makeRun({ events: [{ type: 'error', message: 'Reconnecting... 1/5' }] });
  const { meta, reply } = collect(dir, 'codex-build', 1);

  assert.equal(meta.status, 'FAIL');
  assert.match(reply, /^FAIL — /);
});

test('a recovered build strips a CAPACITY verdict prefix from its summary', () => {
  const result = { ...buildResult([]), summary: 'CAPACITY — recovered work' };
  const dir = makeRun({ events: fixture, result });
  const { meta, reply } = collect(dir, 'codex-build', 0);

  assert.equal(meta.status, 'OK');
  assert.equal(reply.split('\n')[0], 'OK — recovered work');
});
