#!/usr/bin/env node
/**
 * Guards chain.mjs: finding the earlier passes of the task a run belongs to.
 *   node --test agents/codex/meta/chain.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { chainRuns, chainBaseline, taskFingerprint } from '../../src/meta/chain.mjs';
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

test('the fingerprint ignores rewrapping but not rewording', () => {
  assert.equal(taskFingerprint('Do  X\n\nand Y'), taskFingerprint('do x and y'));
  assert.notEqual(taskFingerprint('do x'), taskFingerprint('do z'));
  assert.equal(taskFingerprint('   '), '');
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

test('an empty first snapshot is a clean tree, a missing one is no baseline at all', () => {
  const clean = makeChainRoot([{ name: 'a-first', at: '2026-07-31T09:00:00Z', before: '' }]);
  assert.equal(chainBaseline(clean, CHAIN_REPO, CHAIN_SLUG), '');

  const none = makeChainRoot([{ name: 'a-first', at: '2026-07-31T09:00:00Z' }]);
  assert.equal(chainBaseline(none, CHAIN_REPO, CHAIN_SLUG), null);
  assert.equal(chainBaseline(none, CHAIN_REPO, 'no-such-task'), null);
});
