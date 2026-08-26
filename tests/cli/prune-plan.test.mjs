/** Verifies prune planning, folder-name age selection, and exact target agreement. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import { parsePruneArgs } from '../../cli/prune-args.mjs';
import { prunePlan, runIsOlderThan, TRANSPORT_FILES } from '../../cli/prune-plan.mjs';
import { recursiveSize } from '../../cli/runs-inventory.mjs';
import { TRANSPORT_FILES as RETENTION_FILES } from '../../src/home/lib/retention.mjs';

const NOW = Date.parse('2026-08-06T12:00:00.000Z');

function fixture(t) {
  const root = makeTempTree('prune-plan-');
  t.after(() => removeTempTree(root));
  return root;
}

function makeRun(root, project, run, files = {}) {
  const dir = path.join(root, project, run);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}

test('gentle plans name only transport files and leave the rest outside targets', (t) => {
  const root = fixture(t);
  assert.strictEqual(TRANSPORT_FILES, RETENTION_FILES);
  const run = makeRun(root, 'alpha', '2026-07-01_090000_old', {
    'events.jsonl': 'events',
    'stderr.log': 'stderr',
    'raw.log': 'raw',
    'meta.json': '{}',
    'state-before.txt': 'tree',
    'report.md': 'report',
  });

  const plan = prunePlan(parsePruneArgs(['alpha']), { runsRootPath: root, now: NOW });

  assert.equal(plan.actions.length, 1);
  assert.deepEqual(plan.actions[0].targets, TRANSPORT_FILES.map((name) => path.join(run, name)));
  assert.equal(fs.existsSync(path.join(run, 'meta.json')), true);
  assert.equal(fs.existsSync(path.join(run, 'state-before.txt')), true);
  assert.equal(fs.existsSync(path.join(run, 'report.md')), true);
});

test('duration and exact-date age filters use folder names, never mtimes', (t) => {
  const root = fixture(t);
  const old = makeRun(root, 'alpha', '2026-08-05_230000_old', { 'events.jsonl': 'old' });
  const recent = makeRun(root, 'alpha', '2026-08-06_110000_recent', { 'events.jsonl': 'recent' });
  const undated = makeRun(root, 'alpha', 'manual-run', { 'events.jsonl': 'manual' });
  const oldTime = new Date('2020-01-01T00:00:00.000Z');
  fs.utimesSync(old, oldTime, oldTime);

  assert.equal(runIsOlderThan(path.basename(old), { kind: 'duration', amount: 12, unit: 'h' }, NOW), true);
  assert.equal(runIsOlderThan(path.basename(recent), { kind: 'date', date: '2026-08-06' }, NOW), false);
  assert.equal(runIsOlderThan(path.basename(undated), { kind: 'duration', amount: 1, unit: 'h' }, NOW), false);

  const plan = prunePlan(parsePruneArgs(['alpha', '--older-than', '12h']), {
    runsRootPath: root,
    now: NOW,
  });
  assert.deepEqual(plan.actions.map((action) => action.run), [path.basename(old)]);
  assert.equal(fs.existsSync(path.join(recent, 'events.jsonl')), true);
});

test('project purge plans one project-folder target and uses inventory sizing', (t) => {
  const root = fixture(t);
  const project = path.join(root, 'alpha');
  makeRun(root, 'alpha', '2026-07-01_090000_old', {
    'meta.json': '{}',
    'report.md': 'report',
  });

  const plan = prunePlan(parsePruneArgs(['alpha', '--purge']), { runsRootPath: root, now: NOW });

  assert.equal(plan.actions.length, 1);
  assert.deepEqual(plan.actions[0].targets, [project]);
  assert.equal(plan.bytes, recursiveSize(project));
  assert.equal(fs.existsSync(project), true);
});

test('all-projects plan is gentle and excludes a recent or undated run', (t) => {
  const root = fixture(t);
  makeRun(root, 'alpha', '2026-07-01_090000_old', { 'events.jsonl': 'old' });
  makeRun(root, 'beta', '2026-08-06_110000_recent', { 'events.jsonl': 'recent' });
  makeRun(root, 'gamma', 'manual-run', { 'events.jsonl': 'manual' });

  const plan = prunePlan(parsePruneArgs(['--all-projects']), { runsRootPath: root, now: NOW });

  assert.equal(plan.mode, 'gentle');
  assert.deepEqual(plan.actions.map((action) => action.project), ['alpha']);
  assert.equal(fs.existsSync(path.join(root, 'beta', '2026-08-06_110000_recent', 'events.jsonl')), true);
  assert.equal(fs.existsSync(path.join(root, 'gamma', 'manual-run', 'events.jsonl')), true);
});

test('a young project can still be purged: the age default belongs to gentle cleanup', (t) => {
  const root = fixture(t);
  makeRun(root, 'sbx2', '2026-08-06_010000_fresh', { 'meta.json': '{}', 'events.jsonl': 'e' });

  const plan = prunePlan(parsePruneArgs(['sbx2', '--purge']), { runsRootPath: root, now: NOW });

  // Before 2026-08-06 the implicit 30-day filter reached purges too, so the plan's own fourth
  // scenario answered "nothing to remove" on any project younger than a month.
  assert.equal(plan.olderThan, null);
  assert.equal(plan.actions.length, 1);
  assert.deepEqual(plan.actions[0].targets, [path.join(root, 'sbx2')]);
});

test('a refused whole-project purge says why instead of returning an empty plan', (t) => {
  const root = fixture(t);
  makeRun(root, 'mixed', '2026-01-01_090000_old', { 'meta.json': '{}' });
  makeRun(root, 'mixed', '2026-08-05_090000_new', { 'meta.json': '{}' });

  const args = parsePruneArgs(['mixed', '--purge', '--older-than', '30d']);
  const plan = prunePlan(args, { runsRootPath: root, now: NOW });

  assert.equal(plan.actions.length, 0);
  assert.match(plan.note, /1 of 2 runs .* newer than the age filter/);
});

test('a live run is never a prune target, however the scope is spelled', (t) => {
  const root = fixture(t);
  const live = makeRun(root, 'busy', '2026-01-01_090000_live', {
    'meta.json': '{}',
    'events.jsonl': 'being written right now',
  });
  fs.writeFileSync(path.join(live, 'status.json'), JSON.stringify({
    state: 'running',
    pid: process.pid, // a pid that really answers signal 0
    agent: 'codex-build',
    slug: 'live',
    repo: root,
  }));

  const gentle = prunePlan(parsePruneArgs(['busy']), { runsRootPath: root, now: NOW });
  assert.deepEqual(gentle.actions, []);

  const named = prunePlan(
    parsePruneArgs(['busy', '2026-01-01_090000_live']),
    { runsRootPath: root, now: NOW },
  );
  assert.match(named.error, /still going/);

  const purge = prunePlan(parsePruneArgs(['busy', '--purge']), { runsRootPath: root, now: NOW });
  assert.deepEqual(purge.actions, []);
  assert.match(purge.note, /still going/);
});
