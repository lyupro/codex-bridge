/** Reads run-store directories into inventory data. */
import fs from 'node:fs';
import path from 'node:path';
import { liveRuns } from '../src/hooks/live-runs.mjs';
import { runsRoot } from '../src/runner/runs-root.mjs';

const record = (value) => value && typeof value === 'object' && !Array.isArray(value);

function readRecord(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return record(value) ? value : null;
  } catch {
    return null;
  }
}

function directoryEntries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return [];
  }
}

function measure(target) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return { bytes: null, complete: false };
  }
  if (!stat.isDirectory()) return { bytes: stat.isFile() ? stat.size : 0, complete: true };

  let entries;
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch {
    return { bytes: null, complete: false };
  }

  let bytes = 0;
  let complete = true;
  for (const entry of entries) {
    const child = measure(path.join(target, entry.name));
    if (child.bytes !== null) bytes += child.bytes;
    if (!child.complete) complete = false;
  }
  return { bytes: complete ? bytes : null, complete };
}

/** Measures every readable regular file beneath a path. */
export function recursiveSize(target) {
  return measure(target).bytes;
}

const normalizeRoot = (value) => typeof value === 'string' && value.trim() ? value : runsRoot();

const text = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;

const number = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;

function runTimestamp(name, meta, status) {
  return text(meta?.finished_at)
    || text(status?.finished_at)
    || text(status?.started_at)
    || /^\d{4}-\d{2}-\d{2}_\d{6}/.exec(name)?.[0]
    || null;
}

function timestampOrder(value) {
  const candidate = String(value).replace(
    /^(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})(\d{2})$/,
    '$1T$2:$3:$4',
  );
  const parsed = Date.parse(candidate);
  return Number.isNaN(parsed) ? candidate : parsed;
}

function newer(left, right) {
  if (!left) return right;
  if (!right) return left;
  const leftOrder = timestampOrder(left);
  const rightOrder = timestampOrder(right);
  if (typeof leftOrder === 'number' && typeof rightOrder === 'number') {
    return rightOrder > leftOrder ? right : left;
  }
  if (typeof leftOrder === 'number') return left;
  if (typeof rightOrder === 'number') return right;
  return rightOrder > leftOrder ? right : left;
}

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function readRun(runDir, livePaths) {
  // A damaged folder still gets its row. An inventory that hides what it cannot parse is at its
  // least useful exactly when something is wrong, which is when the operator opens it.
  const meta = readRecord(path.join(runDir, 'meta.json'));
  const status = readRecord(path.join(runDir, 'status.json'));
  const facts = meta || status;
  const live = livePaths.has(pathKey(runDir));
  return {
    run: path.basename(runDir),
    agent: text(facts?.agent),
    verdict: live ? 'running' : text(meta ? meta.status : status?.state),
    tokens: meta ? number(meta.tokens) : null,
    size: recursiveSize(runDir),
    timestamp: runTimestamp(path.basename(runDir), meta, status),
    live,
  };
}

function publicRun(run) {
  return {
    run: run.run,
    agent: run.agent,
    verdict: run.verdict,
    tokens: run.tokens,
    size: run.size,
  };
}

function buildProject(projectDir) {
  const runDirs = directoryEntries(projectDir).map((entry) => path.join(projectDir, entry.name));
  // live-runs owns PID and status interpretation after the 2026-08-05 live probe incident;
  // this module only maps its result back to the corresponding inventory row.
  const livePaths = new Set(liveRuns(projectDir).map(({ dir }) => pathKey(dir)));
  const details = runDirs.map((runDir) => readRun(runDir, livePaths));
  // Sum what is known instead of blanking the column. One archived run without accounting used to
  // erase the total of every run beside it, which reads as "spent nothing" — the opposite of true.
  const counted = details.filter((run) => run.tokens !== null);
  const latest = details.reduce((current, run) => newer(current, run.timestamp), null);
  return {
    summary: {
      project: path.basename(projectDir),
      runs: details.length,
      size: recursiveSize(projectDir),
      totalTokens: counted.length ? counted.reduce((sum, run) => sum + run.tokens, 0) : null,
      liveNow: details.filter((run) => run.live).length,
      lastRun: latest,
    },
    details,
  };
}

function projectDirectory(root, name) {
  return directoryEntries(root)
    .find((entry) => entry.name === name)
    ? path.join(root, name)
    : null;
}

/** Lists one summary row per project directory. */
export function listProjects(runsRootPath = runsRoot()) {
  const root = normalizeRoot(runsRootPath);
  return directoryEntries(root).map((entry) => buildProject(path.join(root, entry.name)).summary);
}

/** Lists one detail row per run directory in a named project, or null when there is no such project. */
export function listProjectRuns(runsRootPath = runsRoot(), projectName) {
  const root = normalizeRoot(runsRootPath);
  const projectDir = projectDirectory(root, projectName);
  if (!projectDir) return null;
  return buildProject(projectDir).details.map(publicRun);
}
