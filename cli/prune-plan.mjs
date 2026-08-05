/** Builds a read-only prune plan from run inventory data and folder-name ages. */
import fs from 'node:fs';
import path from 'node:path';
import { listProjectRuns, listProjects, recursiveSize } from './runs-inventory.mjs';
import { parseOlderThan } from './prune-args.mjs';
import { runsRoot } from '../src/runner/runs-root.mjs';

export const TRANSPORT_FILES = Object.freeze(['events.jsonl', 'stderr.log', 'raw.log']);

function safeFolderName(value) {
  return typeof value === 'string'
    && value.trim()
    && value !== '.'
    && value !== '..'
    && !path.isAbsolute(value)
    && path.dirname(value) === '.';
}

function ageDate(name) {
  const match = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})(?:_|$)/.exec(name);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const timestamp = Date.UTC(
    Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second),
  );
  const date = new Date(timestamp);
  if (date.getUTCFullYear() !== Number(year)
    || date.getUTCMonth() !== Number(month) - 1
    || date.getUTCDate() !== Number(day)
    || date.getUTCHours() !== Number(hour)
    || date.getUTCMinutes() !== Number(minute)
    || date.getUTCSeconds() !== Number(second)) return null;
  return timestamp;
}

function nowTimestamp(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(value ?? '');
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

function ageCutoff(olderThan, now) {
  if (!olderThan) return null;
  if (olderThan.kind === 'duration') {
    const unit = olderThan.unit === 'h' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    return now - olderThan.amount * unit;
  }
  return Date.parse(`${olderThan.date}T00:00:00.000Z`);
}

/** Returns whether a run is older than a parsed threshold, using only its folder name. */
export function runIsOlderThan(runName, olderThan, now = Date.now()) {
  const timestamp = ageDate(runName);
  if (timestamp === null || !olderThan) return false;
  return timestamp < ageCutoff(olderThan, nowTimestamp(now));
}

function normalizeOlderThan(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const parsed = parseOlderThan(value);
    return parsed.error ? null : parsed;
  }
  return value;
}

function fileDetails(runDir) {
  return TRANSPORT_FILES.flatMap((name) => {
    const target = path.join(runDir, name);
    try {
      const stat = fs.lstatSync(target);
      if (!stat.isFile()) return [];
      return [{ name, path: target, bytes: stat.size }];
    } catch {
      return [];
    }
  });
}

function sumBytes(items) {
  return items.every((item) => Number.isFinite(item.bytes))
    ? items.reduce((sum, item) => sum + item.bytes, 0)
    : null;
}

function gentleAction(root, project, run) {
  const runDir = path.join(root, project, run.run);
  const files = fileDetails(runDir);
  if (!files.length) return null;
  return {
    kind: 'run',
    mode: 'gentle',
    project,
    run: run.run,
    path: runDir,
    files,
    targets: files.map((file) => file.path),
    bytes: sumBytes(files),
  };
}

function runPurgeAction(root, project, run) {
  const runDir = path.join(root, project, run.run);
  return {
    kind: 'run',
    mode: 'purge',
    project,
    run: run.run,
    path: runDir,
    files: [],
    targets: [runDir],
    bytes: recursiveSize(runDir),
  };
}

function projectPurgeAction(root, project, runs) {
  const projectDir = path.join(root, project);
  return {
    kind: 'project',
    mode: 'purge',
    project,
    run: null,
    path: projectDir,
    files: [],
    targets: [projectDir],
    bytes: recursiveSize(projectDir),
    runs: runs.map((run) => run.run),
  };
}

function selectedRuns(runs, olderThan, now) {
  return olderThan ? runs.filter((run) => runIsOlderThan(run.run, olderThan, now)) : runs;
}

/**
 * A live run is never a prune target. Its events.jsonl is the verdict being written: delete it and
 * the run ends with "artifacts disagree" over work that was actually done — the exact loss this
 * package spent Plan_15 and Plan_16 removing. The inventory already marks liveness through
 * hooks/live-runs.mjs, so this costs nothing and asks no second opinion.
 */
function withoutLiveRuns(runs) {
  // By the pid probe, not by status.json: an abandoned run also reads `running` there, and those
  // are exactly the folders worth cleaning.
  return runs.filter((run) => run.live !== true);
}

function projectNames(root) {
  return listProjects(root).map((project) => project.project);
}

function projectRuns(root, project) {
  return listProjectRuns(root, project);
}

function broadProjectPlan(root, project, args, age, now) {
  const all = projectRuns(root, project);
  if (all === null) return { error: `codex-bridge prune: unknown project "${project}"` };
  const live = all.filter((run) => run.live === true);
  if (args.purge && live.length) {
    return {
      actions: [],
      note: `${live.length} run(s) in "${project}" are still going; a project purge would delete a run that is writing right now`,
    };
  }
  const runs = withoutLiveRuns(all);
  const selected = selectedRuns(runs, age, now);
  if (args.purge) {
    // A whole-project purge must not let a recent or undated run hide behind an old one. Saying
    // why matters as much as refusing: an empty plan without a reason reads as a broken command,
    // and the operator's next move is to try again harder.
    if (selected.length !== runs.length) {
      return {
        actions: [],
        note: `${runs.length - selected.length} of ${runs.length} runs in "${project}" are newer than the age filter, so the whole-project purge is refused; drop --older-than to purge the folder, or prune the old runs one by one`,
      };
    }
    return { actions: [projectPurgeAction(root, project, runs)] };
  }
  return {
    actions: selected.map((run) => gentleAction(root, project, run)).filter(Boolean),
  };
}

function namedRunPlan(root, project, runName, args, age, now) {
  const runs = projectRuns(root, project);
  if (runs === null) return { error: `codex-bridge prune: unknown project "${project}"` };
  const run = runs.find((entry) => entry.run === runName);
  if (!run) return { error: `codex-bridge prune: unknown run "${runName}" in project "${project}"` };
  if (run.live === true) {
    return {
      error: `codex-bridge prune: run "${runName}" is still going; its events.jsonl is the verdict being written`,
    };
  }
  if (age && !runIsOlderThan(run.run, age, now)) return { actions: [] };
  const action = args.purge
    ? runPurgeAction(root, project, run)
    : gentleAction(root, project, run);
  return { actions: action ? [action] : [] };
}

/** Purely decides what prune would remove; it never writes or deletes a filesystem entry. */
export function prunePlan(args = {}, options = {}) {
  const root = path.resolve(options.runsRootPath || args.runsRootPath || runsRoot());
  const now = options.now ?? Date.now();
  const scope = args.allProjects ? 'all-projects' : args.runName ? 'run' : 'project';
  // The default age lives in the parser and only there. It stood in both places until 2026-08-06,
  // and the two copies disagreed the moment one of them learned that a purge is never implicitly
  // aged — the planner silently restored the filter the parser had just dropped.
  const age = normalizeOlderThan(args.olderThan);

  let actions = [];
  let note = null;
  if (args.allProjects) {
    for (const project of projectNames(root)) {
      const result = broadProjectPlan(root, project, { ...args, purge: false }, age, now);
      if (result.error) return result;
      actions.push(...result.actions);
    }
  } else if (!safeFolderName(args.projectName)) {
    return { error: 'codex-bridge prune: a bare project folder name is required' };
  } else if (args.runName) {
    if (!safeFolderName(args.runName)) {
      return { error: 'codex-bridge prune: a bare run folder name is required' };
    }
    const result = namedRunPlan(root, args.projectName, args.runName, args, age, now);
    if (result.error) return result;
    actions = result.actions;
  } else {
    const result = broadProjectPlan(root, args.projectName, args, age, now);
    if (result.error) return result;
    actions = result.actions;
    note = result.note ?? null;
  }

  return {
    root,
    scope,
    mode: args.purge ? 'purge' : 'gentle',
    project: args.projectName || null,
    run: args.runName || null,
    olderThan: age,
    actions,
    note,
    bytes: sumBytes(actions),
  };
}
