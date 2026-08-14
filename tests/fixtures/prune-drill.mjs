#!/usr/bin/env node
/**
 * Builds a throwaway run store for the deletion steps of the Plan_17-1 operator checklist.
 *
 * `prune` is the only command in this package that destroys data, and the steps that prove it works
 * have to actually delete something. Rehearsing that on real runs puts work someone may still need
 * behind an operator's `y` — so the drill runs on runs that were never real: the shape of a finished
 * run (accounting, reports, worktree snapshots, transport worth hundreds of kilobytes), invented
 * content, June dates so the 30-day age filter lets them through.
 *
 * Not a test: nothing here asserts. It is the fixture an operator builds before the checklist and
 * deletes with the command being checked. Living under tests/ keeps it out of the published
 * tarball, which the files whitelist in package.json does not name.
 *
 *   node tests/fixtures/prune-drill.mjs
 *
 * Creates `cb-drill` (three runs) and `cb-drill-purge` (one) under the run store. Both are removed
 * by the last steps of the checklist itself:
 *
 *   node bin/codex-bridge.mjs prune cb-drill --purge -f
 *   node bin/codex-bridge.mjs prune cb-drill-purge --purge -f
 */
import fs from 'node:fs';
import path from 'node:path';
import { runsRoot } from '../../src/home/lib/runner/runs-root.mjs';

const store = runsRoot();

function makeRun(project, run, { agent, status, tokens, eventsKb, rawKb }) {
  const dir = path.join(store, project, run);
  fs.mkdirSync(dir, { recursive: true });
  const finishedAt = `${run.slice(0, 10)}T09:15:00.000Z`;

  // Transport: what a gentle prune is allowed to take.
  const event = (index) => JSON.stringify({
    type: 'item.completed',
    item: { text: `drill event ${index} - throwaway fixture, safe to delete` },
  });
  const events = Array.from({ length: eventsKb * 10 }, (_, index) => event(index)).join('\n');
  fs.writeFileSync(path.join(dir, 'events.jsonl'), `${events}\n`);
  fs.writeFileSync(path.join(dir, 'stderr.log'), 'drill stderr line\n'.repeat(60));
  // Runs older than 0.2.0 carry raw.log instead of events.jsonl; one drill run has neither, so the
  // plan is seen naming only the files that exist rather than a fixed list.
  if (rawKb) fs.writeFileSync(path.join(dir, 'raw.log'), 'drill raw log line\n'.repeat(rawKb * 55));

  // Accounting and reports: what must survive it.
  fs.writeFileSync(path.join(dir, 'meta.json'), `${JSON.stringify({
    agent,
    project,
    run,
    finished_at: finishedAt,
    exit: status === 'OK' ? 0 : 1,
    status,
    reason: null,
    carried_from_earlier_run: false,
    environment_changes: [],
    result_ok: status === 'OK',
    events_bytes: events.length + 1,
    stderr_bytes: 1080,
    tokens,
    tokens_reported: true,
  }, null, 2)}\n`);
  // state: finished, so no liveness check can mistake a fixture for a run in flight — a pid written
  // here could be reused by a live process and make prune refuse the drill for the wrong reason.
  fs.writeFileSync(path.join(dir, 'status.json'), `${JSON.stringify({
    state: 'finished',
    agent,
    slug: run.slice(18),
    order_id: `prune-drill-${run.slice(18)}`,
    repo: 'C:/example/repo',
    started_at: finishedAt,
    stopped_on_deadline: false,
    elapsed_ms: 120000,
    status,
    finished_at: finishedAt,
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'report.md'), `# Drill report\n\nThrowaway fixture for ${run}.\n`);
  fs.writeFileSync(path.join(dir, 'result.json'), `${JSON.stringify({ answer: 'drill' }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'task.md'), '## Operator task (verbatim)\n\nDrill fixture.\n');
  for (const name of ['state-before.txt', 'state-after.txt', 'git-before.txt', 'git-after.txt', 'diff.stat']) {
    fs.writeFileSync(path.join(dir, name), `drill ${name}\n`);
  }
  return dir;
}

const made = [
  makeRun('cb-drill', '2026-06-01_101010_gentle-target', { agent: 'codex-build', status: 'OK', tokens: 120000, eventsKb: 240, rawKb: 90 }),
  makeRun('cb-drill', '2026-06-02_101010_answer-no', { agent: 'codex-build', status: 'FAIL', tokens: 64000, eventsKb: 120, rawKb: 40 }),
  makeRun('cb-drill', '2026-06-03_101010_no-tty', { agent: 'codex-scout', status: 'OK', tokens: 31000, eventsKb: 80, rawKb: 0 }),
  makeRun('cb-drill-purge', '2026-06-04_101010_probe', { agent: 'codex-scout', status: 'OK', tokens: 12000, eventsKb: 30, rawKb: 0 }),
];

for (const dir of made) console.log(path.relative(store, dir));
