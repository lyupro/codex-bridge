#!/usr/bin/env node
/**
 * Guards chain.mjs: finding the earlier passes of the task a run belongs to.
 *   node --test agents/codex-bridge/meta/chain.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { chainRuns, chainBaseline, taskFingerprint } from '../../src/home/lib/meta/chain.mjs';
import { taskTextWithoutGrants } from '../../src/home/lib/required-inputs.mjs';
import { makeChainRoot, CHAIN_REPO, CHAIN_SLUG } from './test-fixtures.mjs';

test('chainRuns collects the passes of one task and nothing else', () => {
  const root = makeChainRoot([
    { name: 'a-first', at: '2026-07-31T10:00:00Z' },
    { name: 'b-second', at: '2026-07-31T12:00:00Z' },
    { name: 'c-other-repo', at: '2026-07-31T11:00:00Z', repo: '/repo/elsewhere' },
    { name: 'd-other-slug', at: '2026-07-31T11:30:00Z', slug: 'another-task' },
  ]);
  assert.deepEqual(chainRuns(root, CHAIN_REPO, CHAIN_SLUG), ['a-first', 'b-second']);
});

test('chainRuns orders the passes by when they started, not by folder name', () => {
  const root = makeChainRoot([
    { name: 'zzz-earliest', at: '2026-07-31T09:00:00Z' },
    { name: 'aaa-latest', at: '2026-07-31T19:00:00Z' },
  ]);
  assert.deepEqual(chainRuns(root, CHAIN_REPO, CHAIN_SLUG), ['zzz-earliest', 'aaa-latest']);
});

test('an empty task context finds no chain rather than every run in the folder', () => {
  const root = makeChainRoot([{ name: 'a-first', at: '2026-07-31T10:00:00Z' }]);
  assert.deepEqual(chainRuns(root, CHAIN_REPO, ''), []);
  assert.deepEqual(chainRuns(root, '', CHAIN_SLUG), []);
});

test('a repeat that renamed its slug is still the same task', () => {
  // 2026-08-02: a dispatcher that lost its launcher restarted the identical order as
  // `<slug>-v2`, and the slug-only lookup found no chain — 46k spent on an unasked repeat.
  const hash = taskFingerprint('Lock down two environment.mjs guarantees with tests.');
  const root = makeChainRoot([
    { name: 'a-first', at: '2026-08-02T01:42:00Z', taskHash: hash },
    { name: 'b-renamed', at: '2026-08-02T01:45:00Z', slug: `${CHAIN_SLUG}-v2`, taskHash: hash },
  ]);
  assert.deepEqual(chainRuns(root, CHAIN_REPO, `${CHAIN_SLUG}-v2`, hash), ['a-first', 'b-renamed']);
  // Without the fingerprint the rename still hides, which is what the old behaviour was.
  assert.deepEqual(chainRuns(root, CHAIN_REPO, `${CHAIN_SLUG}-v2`), ['b-renamed']);
});

test('a different task under the same slug is not chained by fingerprint', () => {
  const root = makeChainRoot([
    { name: 'a-first', at: '2026-08-02T01:42:00Z', taskHash: taskFingerprint('one task') },
  ]);
  assert.deepEqual(chainRuns(root, CHAIN_REPO, 'other-slug', taskFingerprint('another task')), []);
});

test('an order id chains renamed and reworded passes', () => {
  const root = makeChainRoot([
    { name: 'a-first', at: '2026-08-02T01:42:00Z', slug: 'old-slug', taskHash: taskFingerprint('one task'), orderId: 'order-42' },
    { name: 'b-renamed', at: '2026-08-02T01:45:00Z', slug: 'new-slug', taskHash: taskFingerprint('another task'), orderId: 'order-42' },
  ]);
  assert.deepEqual(chainRuns(root, CHAIN_REPO, 'new-slug', taskFingerprint('another task'), 'order-42'), [
    'a-first',
    'b-renamed',
  ]);
});

test('an order chain exposes both spent passes for the one-continuation cap', () => {
  const root = makeChainRoot([
    { name: 'a-first', at: '2026-08-02T01:42:00Z', orderId: 'order-42' },
    { name: 'b-second', at: '2026-08-02T01:45:00Z', orderId: 'order-42' },
  ]);

  assert.deepEqual(chainRuns(root, CHAIN_REPO, CHAIN_SLUG, '', 'order-42'), ['a-first', 'b-second']);
});

test('an empty order id does not chain older unlabeled runs extra', () => {
  const root = makeChainRoot([
    { name: 'a-first', at: '2026-08-02T01:42:00Z', slug: 'old-slug', taskHash: taskFingerprint('one task') },
    { name: 'b-other', at: '2026-08-02T01:45:00Z', slug: 'other-slug', taskHash: taskFingerprint('another task') },
  ]);
  assert.deepEqual(chainRuns(root, CHAIN_REPO, 'new-slug', taskFingerprint('new task'), ''), []);
});

test('a different order id does not chain a different slug and hash', () => {
  const root = makeChainRoot([
    { name: 'a-first', at: '2026-08-02T01:42:00Z', slug: 'old-slug', taskHash: taskFingerprint('one task'), orderId: 'order-41' },
  ]);
  assert.deepEqual(chainRuns(root, CHAIN_REPO, 'new-slug', taskFingerprint('another task'), 'order-42'), []);
});

test('the fingerprint ignores rewrapping but not rewording', () => {
  assert.equal(taskFingerprint('Do  X\n\nand Y'), taskFingerprint('do x and y'));
  assert.notEqual(taskFingerprint('do x'), taskFingerprint('do z'));
  assert.equal(taskFingerprint('   '), '');
});

test('grant lines do not change the fingerprint, while prose mentioning continue does', () => {
  const task = 'Finish the task.\nKeep its behavior.';
  for (const line of [
    'continue: A — why',
    'retry: A — why',
    '- *continue*: A — why',
    '* _RETRY_: A — why',
    '`Continue`: A — why',
    // Every separator extractValue accepts: a grant it reads must never count toward the hash.
    'continue — A — why',
    'retry = A — why',
  ]) {
    assert.equal(taskFingerprint(`${line}\n${task}`), taskFingerprint(task), line);
  }
  assert.notEqual(taskFingerprint(`We should continue after review.\n${task}`), taskFingerprint(task));
  assert.notEqual(taskFingerprint(`continue later: A\n${task}`), taskFingerprint(task));
  // extractValue does not read a double-wrapped label, so it is not a grant and stays in the hash.
  assert.notEqual(taskFingerprint(`- **continue:** A — why\n${task}`), taskFingerprint(task));
});

test('removing all grant lines preserves every byte of the other lines', () => {
  const task = '  Task café.\r\n\r\nKeep\tspacing.\nLast line';
  const withGrants = 'continue: A — why\r\n  Task café.\r\n\r\n- *retry*: A — why\nKeep\tspacing.\nLast line\ncontinue: B — why';
  assert.equal(taskTextWithoutGrants(withGrants), `${task}\n`);
  assert.equal(taskTextWithoutGrants(task), task);
  assert.equal(taskFingerprint('continue: A — why\nretry: A — why'), '');
});

test('a named run adds its saved handles alongside all original handles', () => {
  const root = makeChainRoot([
    { name: 'A', at: '2026-10-03T00:01:00Z', slug: 'old-slug', taskHash: 'OLD-HASH', orderId: 'o1' },
    { name: 'B-slug', at: '2026-10-03T00:02:00Z', slug: ' OLD-SLUG ', taskHash: 'b', orderId: 'b' },
    { name: 'C-hash', at: '2026-10-03T00:03:00Z', slug: 'c', taskHash: ' old-hash ', orderId: 'c' },
    { name: 'D-order', at: '2026-10-03T00:04:00Z', slug: 'd', taskHash: 'd', orderId: ' o1 ' },
    { name: 'E-original-slug', at: '2026-10-03T00:05:00Z', slug: 'new-slug', taskHash: 'e', orderId: 'e' },
    { name: 'F-original-hash', at: '2026-10-03T00:06:00Z', slug: 'f', taskHash: 'new-hash', orderId: 'f' },
    { name: 'G-original-order', at: '2026-10-03T00:07:00Z', slug: 'g', taskHash: 'g', orderId: 'o2' },
    { name: 'H-unrelated', at: '2026-10-03T00:08:00Z', slug: 'h', taskHash: 'h', orderId: 'h' },
    { name: 'I-foreign', at: '2026-10-03T00:09:00Z', repo: '/other/repo', slug: 'old-slug', orderId: 'o1' },
  ]);
  assert.deepEqual(chainRuns(root, CHAIN_REPO, 'new-slug', 'new-hash', 'o2', 'A'), [
    'A', 'B-slug', 'C-hash', 'D-order', 'E-original-slug', 'F-original-hash', 'G-original-order',
  ]);
  assert.deepEqual(chainRuns(root, CHAIN_REPO, '', '', '', 'A'), ['A', 'B-slug', 'C-hash', 'D-order']);
});

test('foreign, missing and invalid named runs add no handles', () => {
  const root = makeChainRoot([
    { name: 'A', at: '2026-10-03T00:01:00Z', slug: 'old-slug', taskHash: 'old-hash', orderId: 'o1' },
    { name: 'foreign', at: '2026-10-03T00:02:00Z', repo: '/other/repo', slug: 'old-slug', taskHash: 'old-hash', orderId: 'o1' },
    { name: 'original', at: '2026-10-03T00:03:00Z', slug: 'new-slug' },
  ]);
  for (const name of ['foreign', 'missing', '../A', '..\\A', '.', '..', 'A/status.json', 'A\\status.json']) {
    assert.deepEqual(chainRuns(root, CHAIN_REPO, 'new-slug', 'new-hash', 'o2', name), ['original'], name);
    assert.deepEqual(chainRuns(root, CHAIN_REPO, '', '', '', name), [], name);
  }
});

test('runs from before the fingerprint existed still chain by slug', () => {
  const root = makeChainRoot([{ name: 'a-old', at: '2026-07-31T10:00:00Z' }]);
  assert.deepEqual(chainRuns(root, CHAIN_REPO, CHAIN_SLUG, taskFingerprint('anything')), ['a-old']);
});

test('a runs root that does not exist is an empty chain, not a crash', () => {
  const missing = path.join(os.tmpdir(), 'codex-runs-never-created');
  assert.deepEqual(chainRuns(missing, CHAIN_REPO, CHAIN_SLUG), []);
});

test('the baseline is the first pass snapshot, even when a later pass has none at all', () => {
  const root = makeChainRoot([
    { name: 'a-first', at: '2026-07-31T09:00:00Z', before: 'U\t10\tsrc/a.ts\n', after: 'U\t20\tsrc/a.ts\n' },
    // 2026-07-31_114736: killed with neither state-after.txt nor meta.json.
    { name: 'b-killed', at: '2026-07-31T11:00:00Z' },
  ]);
  assert.equal(chainBaseline(root, CHAIN_REPO, CHAIN_SLUG), 'U\t10\tsrc/a.ts\n');
});

test('the baseline skips a pre-start folder that sorts before the first started run', () => {
  const root = makeChainRoot([
    { name: 'a-pre-start', at: '2026-08-01T09:00:00Z', state: 'aborted_pre_start' },
    { name: 'b-started', at: '2026-08-01T10:00:00Z', before: 'U\t10\tsrc/a.ts\n' },
  ]);

  assert.equal(chainBaseline(root, CHAIN_REPO, CHAIN_SLUG), 'U\t10\tsrc/a.ts\n');
});

test('the baseline can be found through the order id alone', () => {
  const root = makeChainRoot([
    { name: 'a-first', at: '2026-08-02T01:42:00Z', slug: 'old-slug', before: 'U\t10\tsrc/a.ts\n', orderId: 'order-42' },
  ]);
  assert.equal(chainBaseline(root, CHAIN_REPO, 'new-slug', '', 'order-42'), 'U\t10\tsrc/a.ts\n');
});

test('an empty first snapshot is a clean tree, a missing one is no baseline at all', () => {
  const clean = makeChainRoot([{ name: 'a-first', at: '2026-07-31T09:00:00Z', before: '' }]);
  assert.equal(chainBaseline(clean, CHAIN_REPO, CHAIN_SLUG), '');

  const none = makeChainRoot([{ name: 'a-first', at: '2026-07-31T09:00:00Z' }]);
  assert.equal(chainBaseline(none, CHAIN_REPO, CHAIN_SLUG), null);
  assert.equal(chainBaseline(none, CHAIN_REPO, 'no-such-task'), null);
});
