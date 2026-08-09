#!/usr/bin/env node
/** Closes dead-pid running records without deleting any run artifacts. */
import fs from 'node:fs';
import path from 'node:path';
import { formatSilence, heartbeatAge, HEARTBEAT_STALE_MS } from '../src/heartbeat.mjs';
import { markAbandoned } from '../src/meta/run-state.mjs';
import {
  IDENTITY_ALIVE,
  IDENTITY_UNVERIFIED,
  processIdentity,
} from '../src/process-identity.mjs';
import { git } from '../src/runner/git-state.mjs';
import { resolveProjectRunsDir } from '../src/runner/project-dir.mjs';
import { runsRoot } from '../src/runner/runs-root.mjs';
import { readJson } from '../src/write-meta.mjs';
import { renderTable } from './table.mjs';

const CLOSED_COLUMNS = [
  { key: 'project', label: 'project' },
  { key: 'run', label: 'run' },
  { key: 'state', label: 'state' },
];
const RECORD_COLUMNS = [
  { key: 'project', label: 'project', truncate: null },
  { key: 'run', label: 'run', truncate: null },
  { key: 'age', label: 'age', truncate: null },
  { key: 'silence', label: 'silent for', truncate: null },
  { key: 'identity', label: 'identity', truncate: null },
  { key: 'state', label: 'state', truncate: null },
];

function result(exitCode, output) {
  return { exitCode, output };
}

function parseArgs(argv) {
  const positional = [];
  let all = false;
  for (const arg of argv) {
    if (arg === '--all') {
      if (all) return { error: 'codex-bridge unlock accepts --all only once.' };
      all = true;
      continue;
    }
    if (typeof arg !== 'string' || arg.startsWith('-')) {
      return { error: `codex-bridge unlock: unknown option "${arg}".` };
    }
    positional.push(arg);
  }
  if (all && positional.length) {
    return { error: 'codex-bridge unlock accepts either --all or one project name.' };
  }
  if (positional.length > 1) {
    return { error: 'codex-bridge unlock accepts at most one project name.' };
  }
  const project = positional[0] || null;
  if (project && (path.isAbsolute(project) || path.dirname(project) !== '.')) {
    return { error: 'codex-bridge unlock requires a bare project name.' };
  }
  return { all, project };
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

function allProjects(root) {
  return directories(root).map((entry) => ({ name: entry.name, dir: path.join(root, entry.name) }));
}

function namedProject(root, projectName) {
  const entry = directories(root).find((candidate) => candidate.name === projectName);
  if (!entry) return { error: `codex-bridge unlock: unknown project "${projectName}".` };
  return [{ name: entry.name, dir: path.join(root, entry.name) }];
}

function currentRepository(cwd) {
  const result = git(cwd, ['rev-parse', '--show-toplevel']);
  const output = String(result.stdout ?? '').trim();
  return result.status === 0 && output ? output : cwd;
}

function selectedProjects(root, parsed, cwd) {
  if (parsed.all) return allProjects(root);
  if (parsed.project) return namedProject(root, parsed.project);
  const resolved = resolveProjectRunsDir(root, currentRepository(cwd), { create: false });
  return [{ name: resolved.name, dir: resolved.dir }];
}

export function unlockPlan(argv = [], options = {}) {
  const parsed = parseArgs(argv);
  if (parsed.error) return parsed;
  const root = path.resolve(options.runsRootPath || runsRoot());
  const projects = selectedProjects(root, parsed, options.cwd || process.cwd());
  if (projects.error) return projects;
  return {
    root,
    all: parsed.all,
    project: parsed.project,
    currentRepository: !parsed.all && !parsed.project,
    projects,
  };
}

function timestamp(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function runAge(startedAt, now) {
  const started = timestamp(startedAt);
  return formatSilence(started === null ? null : Math.max(0, now - started));
}

function identityOptions(runDir, status, options, now) {
  return {
    runDir,
    status,
    now,
    kill: options.kill,
    probe: options.probe,
    processStartProbe: options.processStartProbe,
    commandRunner: options.commandRunner,
  };
}

function inspectRuns(project, options) {
  const now = options.now ?? Date.now();
  const records = [];
  for (const entry of directories(project.dir)) {
    const dir = path.join(project.dir, entry.name);
    const status = readJson(path.join(dir, 'status.json'));
    if (!status || status.state !== 'running') continue;
    const silenceAge = heartbeatAge(dir, now);
    records.push({
      project: project.name,
      run: entry.name,
      age: runAge(status.started_at, now),
      silence: formatSilence(silenceAge),
      silenceAge,
      identity: processIdentity(identityOptions(dir, status, options, now)),
      state: status.state,
    });
  }
  return records;
}

function closeDeadRuns(plan) {
  const closed = [];
  const failures = [];
  for (const project of plan.projects) {
    try {
      // No worktree snapshot is passed, and that is the choice rather than an omission: `stop`
      // closes one named run and knows which repository to look at, while an unlock over the
      // store would have to run git in every repository ever pointed at. The runs it closes died
      // long ago, so a current tree would describe today's work, not their abandoned run.
      for (const change of markAbandoned(project.dir)) {
        closed.push({ project: project.name, run: change.run, state: change.state });
      }
    } catch (error) {
      failures.push({ project: project.name, message: error.message });
    }
  }
  return { closed, failures };
}

function reportRows(records, closed) {
  const closedByRun = new Map(closed.map((change) => [`${change.project}\u0000${change.run}`, change.state]));
  return records.map((record) => ({
    ...record,
    state: closedByRun.get(`${record.project}\u0000${record.run}`) || record.state,
  }));
}

function renderReport(plan, records, closed, failures, options) {
  const scope = plan.all ? 'all projects' : plan.project ? `project "${plan.project}"` : 'the current repository';
  const rows = reportRows(records, closed);
  const stalled = records.filter((record) => (
    record.identity === IDENTITY_ALIVE
      && Number.isFinite(record.silenceAge)
      && record.silenceAge > HEARTBEAT_STALE_MS
  ));
  const alive = records.filter((record) => record.identity === IDENTITY_ALIVE);
  const unverified = records.filter((record) => record.identity === IDENTITY_UNVERIFIED);
  const lines = [`Unlock of ${scope} completed.`];
  if (closed.length) {
    lines.push(`Closed ${closed.length} running record${closed.length === 1 ? '' : 's'}:`);
    lines.push(renderTable(CLOSED_COLUMNS, closed, options));
  } else {
    lines.push('Nothing to close; the store is unchanged.');
  }
  if (rows.length) {
    lines.push('Running records inspected:');
    lines.push(renderTable(RECORD_COLUMNS, rows, options));
  } else {
    lines.push('Running records inspected: none.');
  }
  if (alive.length) {
    lines.push(
      `Refused to close ${alive.length} confirmed-alive run${alive.length === 1 ? '' : 's'}; `
        + 'use codex-bridge stop <run> instead.',
    );
    for (const run of alive) lines.push(`  codex-bridge stop ${run.run}`);
  }
  if (unverified.length) {
    lines.push(
      `Left ${unverified.length} run${unverified.length === 1 ? '' : 's'} untouched because `
        + 'process identity is unverified.',
    );
  }
  if (stalled.length) {
    lines.push(`Left ${stalled.length} live-pid run${stalled.length === 1 ? '' : 's'} with stale heartbeats untouched:`);
    lines.push(renderTable(RECORD_COLUMNS, stalled, options));
  } else {
    lines.push('Live-pid runs with stale heartbeats left untouched: none.');
  }
  if (failures.length) {
    lines.push('Some project records could not be unlocked:');
    for (const failure of failures) lines.push(`  ${failure.project}: ${failure.message}`);
  }
  return lines.join('\n');
}

export function unlock(argv = [], options = {}) {
  const plan = unlockPlan(argv, options);
  if (plan.error) return result(2, plan.error);
  const records = plan.projects.flatMap((project) => inspectRuns(project, options));
  const { closed, failures } = closeDeadRuns(plan);
  return result(
    failures.length ? 1 : 0,
    renderReport(plan, records, closed, failures, options),
  );
}
