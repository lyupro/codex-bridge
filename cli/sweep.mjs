#!/usr/bin/env node
/** Closes dead-pid running records without deleting any run artifacts. */
import fs from 'node:fs';
import path from 'node:path';
import { formatSilence, heartbeatAge, isHeartbeatFresh } from '../src/heartbeat.mjs';
import { markAbandoned, pidAlive } from '../src/meta/run-state.mjs';
import { runsRoot } from '../src/runner/runs-root.mjs';
import { readJson } from '../src/write-meta.mjs';
import { renderTable } from './table.mjs';

const CLOSED_COLUMNS = [
  { key: 'project', label: 'project' },
  { key: 'run', label: 'run' },
  { key: 'state', label: 'state' },
];
const STALE_COLUMNS = [
  { key: 'project', label: 'project' },
  { key: 'run', label: 'run' },
  { key: 'silence', label: 'silent for' },
];

function result(exitCode, output) {
  return { exitCode, output };
}

function parseArgs(argv) {
  const positional = [];
  for (const arg of argv) {
    if (typeof arg !== 'string' || arg.startsWith('-')) {
      return { error: `codex-bridge sweep: unknown option "${arg}".` };
    }
    positional.push(arg);
  }
  if (positional.length > 1) {
    return { error: 'codex-bridge sweep accepts at most one project name.' };
  }
  const project = positional[0] || null;
  if (project && (path.isAbsolute(project) || path.dirname(project) !== '.')) {
    return { error: 'codex-bridge sweep requires a bare project name.' };
  }
  return { project };
}

function directories(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return [];
  }
}

function selectedProjects(root, projectName) {
  const entries = directories(root);
  if (!projectName) {
    return entries.map((entry) => ({ name: entry.name, dir: path.join(root, entry.name) }));
  }
  const entry = entries.find((candidate) => candidate.name === projectName);
  if (!entry) return { error: `codex-bridge sweep: unknown project "${projectName}".` };
  return [{ name: entry.name, dir: path.join(root, entry.name) }];
}

function staleLiveRuns(project) {
  // The 2026-08-06 incident showed why stale heartbeat is report-only: a live worker remains
  // the sole writer until stop kills it and records the outcome.
  const stale = [];
  for (const entry of directories(project.dir)) {
    const dir = path.join(project.dir, entry.name);
    const status = readJson(path.join(dir, 'status.json'));
    if (!status || status.state !== 'running' || !pidAlive(status.pid) || isHeartbeatFresh(dir)) continue;
    stale.push({
      project: project.name,
      run: entry.name,
      silence: formatSilence(heartbeatAge(dir)),
    });
  }
  return stale;
}

export function sweepPlan(argv = [], options = {}) {
  const parsed = parseArgs(argv);
  if (parsed.error) return parsed;
  const root = path.resolve(options.runsRootPath || runsRoot());
  const projects = selectedProjects(root, parsed.project);
  if (projects.error) return projects;
  return { root, project: parsed.project, projects };
}

function closeDeadRuns(plan) {
  const closed = [];
  const failures = [];
  for (const project of plan.projects) {
    try {
      // No worktree snapshot is passed, and that is the choice rather than an omission: `stop`
      // closes one named run and knows which repository to look at, while a sweep of the whole
      // store would have to run git in every repository every project ever pointed at. The runs
      // it closes died long ago, so that list would describe today's tree, not their work — the
      // reason text already says a file list is unavailable, which is the honest answer here.
      for (const change of markAbandoned(project.dir)) {
        closed.push({ project: project.name, run: change.run, state: change.state });
      }
    } catch (error) {
      failures.push({ project: project.name, message: error.message });
    }
  }
  return { closed, failures };
}

function renderReport(plan, closed, stale, failures, options) {
  const scope = plan.project ? `project "${plan.project}"` : 'all projects';
  const lines = [`Sweep of ${scope} completed.`];
  if (closed.length) {
    lines.push(`Closed ${closed.length} running record${closed.length === 1 ? '' : 's'}:`);
    lines.push(renderTable(CLOSED_COLUMNS, closed, options));
  } else {
    lines.push('Nothing to close; the store is unchanged.');
  }
  if (stale.length) {
    lines.push(`Left ${stale.length} live-pid run${stale.length === 1 ? '' : 's'} with stale heartbeats untouched:`);
    lines.push(renderTable(STALE_COLUMNS, stale, options));
    lines.push('End each one explicitly:');
    for (const run of stale) lines.push(`  codex-bridge stop ${run.run}`);
  } else {
    lines.push('Live-pid runs with stale heartbeats left untouched: none.');
  }
  if (failures.length) {
    lines.push('Some project records could not be swept:');
    for (const failure of failures) lines.push(`  ${failure.project}: ${failure.message}`);
  }
  return lines.join('\n');
}

export function sweep(argv = [], options = {}) {
  const plan = sweepPlan(argv, options);
  if (plan.error) return result(2, plan.error);
  const { closed, failures } = closeDeadRuns(plan);
  // This is a report-only probe. markAbandoned owns the closure decision and is the only writer.
  const stale = plan.projects.flatMap((project) => staleLiveRuns(project));
  return result(
    failures.length ? 1 : 0,
    renderReport(plan, closed, stale, failures, options),
  );
}
