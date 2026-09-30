/** Plan_73 B3: judgement must refuse untrustworthy snapshots, not infer a clean tree. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { makeTempTree } from '../temp-tree.mjs';
import { collect } from '../../src/home/lib/write-meta.mjs';
import { reportVersusWork, resolveStatus } from '../../src/home/lib/meta/verdict.mjs';
import { encodeSnapshot } from '../../src/home/lib/meta/snapshot-format.mjs';
import {
  readSnapshot, runSnapshotChanges, snapshotRefusal,
} from '../../src/home/lib/meta/run-snapshots.mjs';
import {
  buildResult as build, makeRun, makeChainRoot, CHAIN_REPO, CHAIN_SLUG,
} from './test-fixtures.mjs';

const file = 'src/проверка.mjs';
const v2 = (state = '1\t0', name = file) => encodeSnapshot([{ path: name, state }]);
const claim = (name = file) => build([{ file: name, what: 'edit', why: 'task' }]);

test('readSnapshot distinguishes an absent file from an empty legacy snapshot', () => {
  const dir = makeTempTree('bridge-run-snapshots-');
  const before = path.join(dir, 'state-before.txt');
  assert.equal(readSnapshot(before), null);
  fs.writeFileSync(path.join(dir, 'state-after.txt'), '');
  assert.deepEqual(runSnapshotChanges(dir), {
    ok: false, side: 'before', issue: 'missing', detail: 'Snapshot file is absent.',
  });
  fs.writeFileSync(before, '');
  assert.equal(readSnapshot(before), '');
  assert.deepEqual(runSnapshotChanges(dir), { ok: true, changed: [] });
});

test('readSnapshot rethrows read errors other than a missing file', () => {
  assert.throws(() => readSnapshot(makeTempTree('bridge-unreadable-snapshot-')),
    (error) => error.code !== 'ENOENT');
});

test('snapshotRefusal names the side only when the comparison provides it', () => {
  assert.equal(snapshotRefusal({ side: 'after', issue: 'missing', detail: 'Absent.' }),
    'worktree snapshots cannot be compared (after missing): Absent.');
  assert.equal(snapshotRefusal({ issue: 'incompatible-versions', detail: 'Restart.' }),
    'worktree snapshots cannot be compared (incompatible-versions): Restart.');
});

test('a v2 Cyrillic in-scope build edit is OK and its exact path is displayed', () => {
  const dir = makeRun({ result: claim(), before: v2(), after: v2('2\t0'), scope: 'src/**\n' });
  const { meta, reply } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'OK');
  assert.ok(reply.includes(file));
  assert.deepEqual(runSnapshotChanges(dir), { ok: true, changed: [file] });
});

test('the same v2 Cyrillic name outside scope fails before report matching', () => {
  const dir = makeRun({ result: claim(), before: v2(), after: v2('2\t0'), scope: 'docs/**\n' });
  const { meta } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'FAIL');
  assert.equal(meta.reason, `out-of-scope changes (1): ${file}`);
});

for (const [name, before, after] of [
  ['v1/v2', '1\t0\tsrc/a.mjs\n', v2()],
  ['v2/v1', v2(), '1\t0\tsrc/a.mjs\n'],
]) {
  test(`${name} fails with incompatible-versions both with and without scope`, () => {
    for (const scope of ['src/**\n', '']) {
      const dir = makeRun({ result: claim(), before, after, scope });
      const verdict = reportVersusWork(dir, claim());
      assert.equal(verdict.ok, false);
      assert.equal(verdict.carried, false);
      assert.match(verdict.reason, /\(incompatible-versions\)/);
      const { meta } = collect(dir, 'codex-build', 0);
      assert.equal(meta.status, 'FAIL');
      assert.match(meta.reason, /\(incompatible-versions\)/);
    }
  });
}

test('a legacy git-quoted name fails instead of being judged as a literal path', () => {
  // The 2026-09-30 incident: git octal escapes are not the original Cyrillic spelling.
  const quoted = '1\t0\t"src/\\320\\277.mjs"\n';
  for (const [before, after, side] of [[quoted, '', 'before'], ['', quoted, 'after']]) {
    const dir = makeRun({ result: claim(), before, after, scope: 'src/**\n' });
    const { meta } = collect(dir, 'codex-build', 0);
    assert.equal(meta.status, 'FAIL');
    assert.match(meta.reason, new RegExp(`\\(${side} legacy-quoted-name\\)`));
  }
});

test('equal-size untracked edits change when their sha256 changes', () => {
  const state = (text) => `U\t${Buffer.byteLength(text)}:${createHash('sha256').update(text).digest('hex')}`;
  const before = v2(state('first'));
  const after = v2(state('other'));
  const dir = makeRun({ result: claim(), before, after, scope: 'src/**\n' });
  assert.deepEqual(runSnapshotChanges(dir), { ok: true, changed: [file] });
  assert.equal(collect(dir, 'codex-build', 0).meta.status, 'OK');
});

for (const side of ['before', 'after']) {
  test(`a missing ${side} snapshot fails even with no declared changes`, () => {
    const dir = makeTempTree('bridge-missing-run-snapshot-');
    const other = side === 'before' ? 'after' : 'before';
    fs.writeFileSync(path.join(dir, `state-${other}.txt`), '');
    const verdict = reportVersusWork(dir, build([]));
    assert.equal(verdict.ok, false);
    assert.equal(verdict.carried, false);
    assert.match(verdict.reason, new RegExp(`\\(${side} missing\\)`));
    for (const scope of ['', 'src/**\n']) {
      fs.writeFileSync(path.join(dir, 'scope.txt'), scope);
      const status = resolveStatus({
        resultOk: true, exit: 0, agent: 'codex-build', result: build([]), runDir: dir,
        events: { hasEvents: false, hasStream: false },
      });
      assert.equal(status.status, 'FAIL');
      assert.match(status.reason, new RegExp(`\\(${side} missing\\)`));
    }
  });

  test(`a malformed ${side} snapshot refuses both scope and report judgement`, () => {
    const snapshots = { before: '', after: '', [side]: 'damaged row\n' };
    for (const scope of ['', 'src/**\n']) {
      const dir = makeRun({ result: build([]), ...snapshots, scope });
      const { meta } = collect(dir, 'codex-build', 0);
      assert.equal(meta.status, 'FAIL');
      assert.match(meta.reason, new RegExp(`\\(${side} malformed\\)`));
    }
  });
}

test('a failed verification retains priority over snapshot refusal', () => {
  const dir = makeRun({
    result: build([], { verify_passed: false }), before: 'broken\n', after: '', scope: 'src/**\n',
  });
  const { meta } = collect(dir, 'codex-build', 0);
  assert.equal(meta.status, 'FAIL');
  assert.match(meta.reason, /verification.*failed/);
  assert.doesNotMatch(meta.reason, /snapshots cannot be compared/);
});

for (const [name, baseline] of [
  ['incompatible', ''], ['malformed', 'broken\n'], ['quoted', '1\t0\t"src/quoted.mjs"\n'],
]) {
  test(`a ${name} chain baseline cannot carry otherwise unchanged v2 work`, () => {
    const root = makeChainRoot([
      { name: 'a-first', at: '2026-07-31T10:00:00Z', before: baseline, after: v2() },
      { name: 'b-second', at: '2026-07-31T12:00:00Z', before: v2(), after: v2() },
    ]);
    const verdict = reportVersusWork(path.join(root, 'b-second'), claim(), {
      runsRoot: root, repo: CHAIN_REPO, slug: CHAIN_SLUG,
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.carried, false);
    assert.equal(verdict.reason,
      'run did not change the tree, and earlier runs of this task do not contain the declared files');
  });
}

test('a compatible v2 chain baseline still carries earlier Cyrillic work', () => {
  const root = makeChainRoot([
    { name: 'a-first', at: '2026-07-31T10:00:00Z', before: encodeSnapshot([]), after: v2() },
    { name: 'b-second', at: '2026-07-31T12:00:00Z', before: v2(), after: v2() },
  ]);
  assert.deepEqual(reportVersusWork(path.join(root, 'b-second'), claim(), {
    runsRoot: root, repo: CHAIN_REPO, slug: CHAIN_SLUG,
  }), { ok: true, carried: true, reason: null });
});
