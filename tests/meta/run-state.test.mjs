#!/usr/bin/env node
/**
 * Guards run-state.mjs: status.json, writeFailure, markAbandoned, activeRun,
 * abandonedBranchDrift.
 *   node --test agents/codex-bridge/meta/run-state.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempTree } from '../temp-tree.mjs';
import {
  writeStatus,
  markAbandoned,
  activeRun,
  abandonedBranchDrift,
  writeFailure,
  failureRecord,
} from '../../src/home/lib/meta/run-state.mjs';
import { HEARTBEAT_FILE, HEARTBEAT_STALE_MS } from '../../src/home/lib/heartbeat.mjs';
import { makeChainRoot } from './test-fixtures.mjs';
import { orderDiagnosticMessage } from '../../src/home/lib/order-diagnostics.mjs';

// A dispatcher pid this OS will never hand out, so pidAlive() reads it as dead everywhere
// these tests run (verified against the real implementation, not assumed).
const DEAD_PID = 999999999;

function setHeartbeatAge(runDir, age) {
  const heartbeat = path.join(runDir, HEARTBEAT_FILE);
  fs.writeFileSync(heartbeat, 'progress\n');
  const at = new Date(Date.now() - age);
  fs.utimesSync(heartbeat, at, at);
}

// OW-067 / Plan_81 D2: keep the old record's field order and serialized bytes during extraction.
function expectedFailure(runDir, reason, finishedAt) {
  return {
    agent: 'codex-build', phase: null, project: path.basename(path.dirname(runDir)),
    run: path.basename(runDir), finished_at: finishedAt, exit: null, status: 'FAIL', reason,
    result_ok: false, events_bytes: 0, stderr_bytes: 0, tokens: null, tokens_reported: false,
    model: null, sandbox: null, session_id: null, env: null,
  };
}
const recordBytes = (record) => `${JSON.stringify(record, null, 2)}\n`;

test('writeFailure() leaves status.json in the failed state with unchanged bytes', () => {
  const dir = makeTempTree('codex-run-');
  const reason = 'x'.repeat(400);
  const shortened = `${reason.slice(0, 297)}...`;
  const built = failureRecord(dir, 'codex-build', reason);
  assert.deepEqual(built, expectedFailure(dir, shortened, built.finished_at));
  assert.equal(fs.existsSync(path.join(dir, 'meta.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'status.json')), false);
  const { meta, reply } = writeFailure(dir, 'codex-build', reason, { action: 'fail-no-result' });
  assert.equal(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'),
    recordBytes(expectedFailure(dir, shortened, meta.finished_at)));
  assert.equal(reply, `FAIL — ${shortened}\n${orderDiagnosticMessage('next-action', { variant: 'fail-no-result' })}\nRun: ${dir}`);
  assert.equal(meta.status, 'FAIL');
  const status = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
  assert.equal(status.state, 'failed');
  assert.equal(status.status, 'FAIL');
  assert.equal(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'),
    recordBytes({ state: 'failed', status: 'FAIL', finished_at: meta.finished_at }));
});

test('writeFailure() can record a refusal that never started Codex', () => {
  const dir = makeTempTree('codex-run-');
  const { meta } = writeFailure(dir, 'codex-build', 'Codex was not started', { action: 'runner-fault', preStart: true });
  const status = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));

  assert.equal(status.state, 'aborted_pre_start');
  assert.equal(status.status, 'FAIL');
  assert.equal(meta.session_id, null);
  assert.equal(meta.events_bytes, 0);
  assert.equal(meta.stderr_bytes, 0);
});

test('markAbandoned marks a dead, meta-less running run as abandoned', (t) => {
  const runsRoot = makeTempTree('codex-runs-');
  const runDir = path.join(runsRoot, 'run1');
  fs.mkdirSync(runDir);
  writeStatus(runDir, { state: 'running', pid: DEAD_PID, repo: '/repo', agent: 'codex-build' });
  const copies = path.join(runDir, 'flags-baseline');
  const manifest = path.join(runDir, 'flags-baseline.json');
  const manifestText = JSON.stringify({ version: 1, files: [{ path: 'a.mjs', copy: '0.bin' }] });
  fs.mkdirSync(copies);
  fs.writeFileSync(path.join(copies, '0.bin'), 'start content\n');
  fs.writeFileSync(manifest, manifestText);
  const realRemove = fs.rmSync;
  let removals = 0;
  // Plan_60 D3a: settle status before deleting a dead worker's start copies.
  t.mock.method(fs, 'rmSync', function rmSync(file, ...rest) {
    if (file === copies) {
      removals += 1;
      assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, 'status.json'), 'utf8')).state, 'abandoned');
    }
    return realRemove.call(this, file, ...rest);
  });

  const changed = markAbandoned(runsRoot);
  t.mock.restoreAll();

  assert.deepEqual(changed, [{ run: 'run1', state: 'abandoned' }]);
  const status = JSON.parse(fs.readFileSync(path.join(runDir, 'status.json'), 'utf8'));
  assert.equal(status.state, 'abandoned');
  assert.match(status.abandoned_reason, /meta\.json was not recorded/);
  assert.equal(removals, 1);
  assert.equal(fs.existsSync(copies), false);
  assert.equal(fs.readFileSync(manifest, 'utf8'), manifestText);
});

test('markAbandoned preserves golden bytes with one meta publication then one status publication', (t) => {
  const runsRoot = makeTempTree('codex-runs-');
  const runDir = path.join(runsRoot, 'golden');
  fs.mkdirSync(runDir);
  const initial = { state: 'running', pid: DEAD_PID, repo: '/repo', agent: 'codex-build' };
  writeStatus(runDir, initial);
  const publications = [];
  const rename = fs.renameSync;
  // OW-067 / Plan_81 D2: observe committed records, including any transient failed state.
  t.mock.method(fs, 'renameSync', function (from, to) {
    const result = rename.call(this, from, to);
    if (path.dirname(to) === runDir) {
      publications.push([path.basename(to), JSON.parse(fs.readFileSync(to, 'utf8')).state]);
    }
    return result;
  });
  assert.deepEqual(markAbandoned(runsRoot), [{ run: 'golden', state: 'abandoned' }]);
  const meta = JSON.parse(fs.readFileSync(path.join(runDir, 'meta.json'), 'utf8'));
  const reason = 'runner process is dead, meta.json was not recorded; ' +
    'no current worktree snapshot was supplied, so no file list is available. ' +
    'This comparison runs at the start of a later run, so its file list may include work made after ' +
    'the abandoned run and is not a definitive list of that run\'s work; ' +
    'post-run worktree state was not captured — its changes will enter the baseline of the next run';
  assert.ok(reason.length > 300);
  assert.equal(fs.readFileSync(path.join(runDir, 'meta.json'), 'utf8'),
    recordBytes(expectedFailure(runDir, reason, meta.finished_at)));
  assert.equal(fs.readFileSync(path.join(runDir, 'status.json'), 'utf8'), recordBytes({
    ...initial, state: 'abandoned', status: 'FAIL', finished_at: meta.finished_at,
    tree_after: false, abandoned_reason: reason, abandoned_at: meta.finished_at,
  }));
  assert.deepEqual(publications, [['meta.json', undefined], ['status.json', 'abandoned']]);
});

for (const blocked of ['meta.json', 'status.json']) {
  test(`markAbandoned contains a failing ${blocked} publication and continues`, (t) => {
    const runsRoot = makeTempTree('codex-runs-');
    const runDir = path.join(runsRoot, 'a-blocked');
    const nextDir = path.join(runsRoot, 'z-next');
    for (const dir of [runDir, nextDir]) {
      fs.mkdirSync(dir);
      writeStatus(dir, { state: 'running', pid: DEAD_PID, agent: 'codex-build' });
    }
    const copies = path.join(runDir, 'flags-baseline');
    fs.mkdirSync(copies);
    fs.writeFileSync(path.join(copies, '0.bin'), 'baseline');
    const before = fs.readFileSync(path.join(runDir, 'status.json'), 'utf8');
    const rename = fs.renameSync;
    let attempts = 0;
    // OW-067 / Plan_81 D2: create the obstruction at publication so the verdict-read guard stays intact.
    t.mock.method(fs, 'renameSync', function (from, to) {
      if (to === path.join(runDir, blocked)) {
        attempts += 1;
        if (blocked === 'meta.json') fs.mkdirSync(to, { recursive: true });
        else throw Object.assign(new Error('status publication failed'), { code: 'EIO' });
      }
      return rename.call(this, from, to);
    });
    let removals = 0;
    const rm = fs.rmSync;
    t.mock.method(fs, 'rmSync', function (file, ...rest) {
      if (file === copies) removals += 1;
      return rm.call(this, file, ...rest);
    });
    let changed;
    assert.doesNotThrow(() => { changed = markAbandoned(runsRoot); });
    assert.ok(attempts > 0, 'the fixture must reach publication');
    assert.deepEqual(changed, [{ run: 'z-next', state: 'abandoned' }]);
    assert.equal(fs.readFileSync(path.join(runDir, 'status.json'), 'utf8'), before);
    assert.equal(fs.readFileSync(path.join(copies, '0.bin'), 'utf8'), 'baseline');
    assert.equal(removals, 0);
  });
}

test('an abandoned run says its tree was never snapshotted either', () => {
  // 2026-07-31_114736 wrote eleven files and left no state-after.txt, so the next pass of
  // that task started from a base that already contained them. The missing verdict was
  // recorded; the missing snapshot was not, and that is what made the later arithmetic lie.
  const runsRoot = makeTempTree('codex-runs-');
  const runDir = path.join(runsRoot, 'run-killed');
  fs.mkdirSync(runDir);
  writeStatus(runDir, { state: 'running', pid: DEAD_PID, repo: '/repo', agent: 'codex-build' });

  markAbandoned(runsRoot);

  const status = JSON.parse(fs.readFileSync(path.join(runDir, 'status.json'), 'utf8'));
  assert.equal(status.tree_after, false);
  assert.match(status.abandoned_reason, /post-run worktree state was not captured/);
  assert.match(status.abandoned_reason, /will enter the baseline of the next run/);
});

test('markAbandoned writes a FAIL verdict with the later worktree file list', () => {
  const runsRoot = makeTempTree('codex-runs-');
  const runDir = path.join(runsRoot, 'run-files');
  fs.mkdirSync(runDir);
  writeStatus(runDir, { state: 'running', pid: DEAD_PID, repo: '/repo', agent: 'codex-build' });
  fs.writeFileSync(path.join(runDir, 'state-before.txt'), '0\t0\ttracked.txt\nU\t4\told.txt\n');
  const currentTree = '1\t0\ttracked.txt\nU\t4\told.txt\nU\t3\tnew.txt\n';

  markAbandoned(runsRoot, currentTree);

  const meta = JSON.parse(fs.readFileSync(path.join(runDir, 'meta.json'), 'utf8'));
  assert.equal(meta.status, 'FAIL');
  assert.match(meta.reason, /tracked\.txt/);
  assert.match(meta.reason, /new\.txt/);
  assert.match(meta.reason, /later run/);
  assert.match(meta.reason, /not a definitive list/);
  assert.equal(fs.existsSync(path.join(runDir, 'state-after.txt')), false);
});

// Review 2026-09-17 (Plan_57 D28): the liveness judge reads meta.json before markAbandoned reads it
// again. A second read that fails must leave the verdict alone, not overwrite OK with an abandoned FAIL.
test('markAbandoned leaves a verdict alone when its second meta.json read fails', (t) => {
  const runsRoot = makeTempTree('codex-runs-');
  const runDir = path.join(runsRoot, 'run-flaky');
  fs.mkdirSync(runDir);
  writeStatus(runDir, { state: 'running', pid: DEAD_PID, repo: '/repo', agent: 'codex-build' });
  const metaPath = path.join(runDir, 'meta.json');
  const metaText = JSON.stringify({ status: 'OK', finished_at: 'X' });
  fs.writeFileSync(metaPath, metaText);
  const realRead = fs.readFileSync;
  let metaReads = 0;
  t.mock.method(fs, 'readFileSync', function readFileSync(file, ...rest) {
    if (path.resolve(String(file)) === path.resolve(metaPath)) {
      metaReads += 1;
      if (metaReads === 2) throw Object.assign(new Error('EACCES: transient'), { code: 'EACCES' });
    }
    return realRead.call(this, file, ...rest);
  });

  const changed = markAbandoned(runsRoot);
  t.mock.restoreAll();

  assert.equal(metaReads, 2, 'the fixture must reach the second read it is written for');
  assert.deepEqual(changed, []);
  assert.equal(fs.readFileSync(metaPath, 'utf8'), metaText);
  assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, 'status.json'), 'utf8')).state, 'running');
});

test('markAbandoned repairs a dead running run that already has a meta.json to finished', () => {
  const runsRoot = makeTempTree('codex-runs-');
  const runDir = path.join(runsRoot, 'run2');
  fs.mkdirSync(runDir);
  writeStatus(runDir, { state: 'running', pid: DEAD_PID, repo: '/repo', agent: 'codex-build' });
  const metaText = JSON.stringify({ status: 'OK', finished_at: 'X' });
  fs.writeFileSync(path.join(runDir, 'meta.json'), metaText);
  const copies = path.join(runDir, 'flags-baseline');
  fs.mkdirSync(copies);
  fs.writeFileSync(path.join(copies, '0.bin'), 'start content\n');

  const changed = markAbandoned(runsRoot);

  assert.deepEqual(changed, [{ run: 'run2', state: 'finished' }]);
  const status = JSON.parse(fs.readFileSync(path.join(runDir, 'status.json'), 'utf8'));
  assert.equal(status.state, 'finished');
  assert.equal(status.status, 'OK');
  assert.equal(status.finished_at, 'X');
  assert.equal(fs.readFileSync(path.join(runDir, 'meta.json'), 'utf8'), metaText);
  assert.equal(fs.readFileSync(path.join(copies, '0.bin'), 'utf8'), 'start content\n');
});

test('markAbandoned keeps a pre-Plan_20 running record without heartbeat alive', () => {
  const runsRoot = makeTempTree('codex-runs-');
  const runDir = path.join(runsRoot, 'run3');
  fs.mkdirSync(runDir);
  const before = writeStatus(runDir, { state: 'running', pid: process.pid, repo: '/repo', agent: 'codex-build' });

  const changed = markAbandoned(runsRoot);

  assert.deepEqual(changed, []);
  const status = JSON.parse(fs.readFileSync(path.join(runDir, 'status.json'), 'utf8'));
  assert.deepEqual(status, before);
});

// A stale heartbeat releases the hooks' lock, never this record. Closing a run whose pid still
// lives would make markAbandoned the second writer of its meta.json — the live worker reaches
// collect() afterwards and overwrites the verdict. `stop` closes stalled runs, killing first.
test('markAbandoned leaves a live-pid run alone even when its heartbeat is stale', () => {
  const runsRoot = makeTempTree('codex-runs-');
  const runDir = path.join(runsRoot, 'stalled');
  fs.mkdirSync(runDir);
  writeStatus(runDir, { state: 'running', pid: process.pid, repo: '/repo', agent: 'codex-build' });
  setHeartbeatAge(runDir, HEARTBEAT_STALE_MS + 1_000);

  assert.deepEqual(markAbandoned(runsRoot), []);
  const status = JSON.parse(fs.readFileSync(path.join(runDir, 'status.json'), 'utf8'));
  assert.equal(status.state, 'running');
  assert.equal(status.abandoned_reason, undefined);
});

test('activeRun keeps a pre-Plan_20 build run without heartbeat live', () => {
  const runsRoot = makeTempTree('codex-runs-');
  const runDir = path.join(runsRoot, 'build-alive');
  fs.mkdirSync(runDir);
  writeStatus(runDir, { state: 'running', pid: process.pid, repo: '/repo/a', agent: 'codex-build' });

  assert.equal(activeRun(runsRoot, '/repo/a'), 'build-alive');
});

// Two writing runs in one worktree is the 2026-08-05 incident. A stalled run still owns the
// tree while its process can wake up; the operator ends it with `stop`, which kills it first.
test('activeRun still refuses a second writing run while the pid lives', () => {
  const runsRoot = makeTempTree('codex-runs-');
  const runDir = path.join(runsRoot, 'build-stalled');
  fs.mkdirSync(runDir);
  writeStatus(runDir, { state: 'running', pid: process.pid, repo: '/repo/a', agent: 'codex-build' });
  setHeartbeatAge(runDir, HEARTBEAT_STALE_MS + 1_000);

  assert.equal(activeRun(runsRoot, '/repo/a'), 'build-stalled');
});

test('activeRun ignores a live build run against a different repo', () => {
  const runsRoot = makeTempTree('codex-runs-');
  const runDir = path.join(runsRoot, 'build-alive');
  fs.mkdirSync(runDir);
  writeStatus(runDir, { state: 'running', pid: process.pid, repo: '/repo/a', agent: 'codex-build' });

  assert.equal(activeRun(runsRoot, '/repo/zzz'), null);
});

test('activeRun ignores a live scout run when asked about a build', () => {
  const runsRoot = makeTempTree('codex-runs-');
  const runDir = path.join(runsRoot, 'scout-alive');
  fs.mkdirSync(runDir);
  writeStatus(runDir, { state: 'running', pid: process.pid, repo: '/repo/a', agent: 'codex-scout' });

  assert.equal(activeRun(runsRoot, '/repo/a'), null);
});

test('activeRun ignores a running entry whose pid is dead', () => {
  const runsRoot = makeTempTree('codex-runs-');
  const runDir = path.join(runsRoot, 'build-dead');
  fs.mkdirSync(runDir);
  writeStatus(runDir, { state: 'running', pid: DEAD_PID, repo: '/repo/b', agent: 'codex-build' });

  assert.equal(activeRun(runsRoot, '/repo/b'), null);
});

// One abandoned pass of a build run against /repo/a, which is the only shape this check
// looks at. `state` goes through the fixture rather than a second status.json written on
// top of it: a test that rewrites the fixture's own artifact stops testing the fixture.
const abandonedRoot = (runs) =>
  makeChainRoot(runs.map((run) => ({ repo: '/repo/a', ...run, state: 'abandoned' })));

test('abandoned detached run reports the recorded branch', () => {
  const root = abandonedRoot([{ name: 'abandoned', branchBefore: 'master' }]);
  assert.deepEqual(abandonedBranchDrift(root, '/repo/a', ''), { run: 'abandoned', branch: 'master' });
});

test('abandoned branch drift clears when the repository is back on the branch', () => {
  const root = abandonedRoot([{ name: 'abandoned', branchBefore: 'master' }]);
  assert.equal(abandonedBranchDrift(root, '/repo/a', 'master'), null);
});

test('abandoned branch drift ignores normal work on another branch', () => {
  const root = abandonedRoot([{ name: 'abandoned', branchBefore: 'master' }]);
  assert.equal(abandonedBranchDrift(root, '/repo/a', 'feature'), null);
});

test('abandoned run with an empty branch snapshot is ignored', () => {
  const root = abandonedRoot([{ name: 'abandoned', branchBefore: '' }]);
  assert.equal(abandonedBranchDrift(root, '/repo/a', ''), null);
});

test('finished run with branch artifacts is ignored', () => {
  const root = makeChainRoot([{ name: 'finished', repo: '/repo/a', branchBefore: 'master' }]);
  assert.equal(abandonedBranchDrift(root, '/repo/a', ''), null);
});

test('abandoned run from another repository is ignored', () => {
  const root = abandonedRoot([{ name: 'other', repo: '/repo/b', branchBefore: 'master' }]);
  assert.equal(abandonedBranchDrift(root, '/repo/a', ''), null);
});

test('newest abandoned run wins', () => {
  const root = abandonedRoot([
    { name: 'older', branchBefore: 'master', at: '2026-08-01' },
    { name: 'newer', branchBefore: 'feature', at: '2026-08-02' },
  ]);
  assert.deepEqual(abandonedBranchDrift(root, '/repo/a', ''), { run: 'newer', branch: 'feature' });
});
