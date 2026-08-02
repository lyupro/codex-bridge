/**
 * Records what state a run is in, on disk, where the next run can see it.
 *
 * A killed runner leaves no report and no meta.json, and four abandoned folders from one
 * order were indistinguishable from four runs still working — status.json is what makes
 * that difference visible. writeFailure() lives here for the same reason: a failure that
 * happens before Codex could produce anything still has to leave both files behind, so
 * there is no second path by which a reply could exist without an artifact backing it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { line, normalizePath, readJson, size } from './paths.mjs';

/**
 * Is this pid still running? EPERM means the process exists and belongs to someone else,
 * which for our purposes is alive — treating it as dead would mark a live run abandoned.
 */
export const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

/**
 * Run state on disk, merged over whatever is already there. A killed runner leaves no
 * report and no meta.json, and four abandoned folders from one order were indistinguishable
 * from four runs still working — status.json is what makes that difference visible.
 */
export function writeStatus(runDir, patch) {
  const current = readJson(path.join(runDir, 'status.json')) || {};
  const next = { ...current, ...patch };
  fs.writeFileSync(path.join(runDir, 'status.json'), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/**
 * Closes out runs whose runner died without writing a verdict. Called at the start of every
 * run, so a folder left by a killed dispatcher gets an explicit state instead of reading as
 * "something is missing here". A dead pid with meta.json present is not abandoned — the
 * verdict exists, only the final status write was lost, so the state is repaired to
 * finished. Returns what changed, for callers that want to report it.
 */
export function markAbandoned(runsRoot) {
  let entries;
  try {
    entries = fs.readdirSync(runsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const changed = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const runDir = path.join(runsRoot, entry.name);
    const status = readJson(path.join(runDir, 'status.json'));
    if (!status || status.state !== 'running' || pidAlive(status.pid)) continue;
    const meta = readJson(path.join(runDir, 'meta.json'));
    const patch = meta
      ? { state: 'finished', status: meta.status, finished_at: meta.finished_at }
      : {
          state: 'abandoned',
          // The verdict is not the only thing missing. 2026-07-31_114736 wrote eleven files
          // and never snapshotted the tree afterwards, so the next pass of that task started
          // from a base that already contained them and every later count lied in silence.
          // The flag exists so that base is read as unknown rather than as clean.
          tree_after: false,
          abandoned_reason:
            'runner process is dead, meta.json was not recorded; post-run worktree state was not ' +
              'captured — its changes will enter the baseline of the next run',
          abandoned_at: new Date().toISOString(),
        };
    try {
      writeStatus(runDir, patch);
      changed.push({ run: entry.name, state: patch.state });
    } catch {
      // A folder that cannot be written to is not worth failing a fresh run over.
    }
  }
  return changed;
}

/**
 * A live run of the same agent against the same repository, or null. Two writing runs share
 * one worktree with no isolation: the second one's before/after snapshot picks up the
 * first one's edits, so an honest run gets failed for work it never did. Read-only agents
 * are not looked at — running scouting alongside a build is the normal way to work.
 */
export function activeRun(runsRoot, repo, agent = 'codex-build') {
  let entries;
  try {
    entries = fs.readdirSync(runsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  const wanted = normalizePath(repo);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const status = readJson(path.join(runsRoot, entry.name, 'status.json'));
    if (!status || status.state !== 'running' || status.agent !== agent) continue;
    if (normalizePath(status.repo) !== wanted) continue;
    if (pidAlive(status.pid)) return entry.name;
  }
  return null;
}

/**
 * A failure that happens before Codex could produce anything — missing CLI, a crash of
 * the runner itself. It still goes through meta.json, so there is no second path by
 * which a reply could exist without an artifact backing it.
 */
export function writeFailure(runDir, agent, reason, extraLines = []) {
  const meta = {
    agent,
    project: path.basename(path.dirname(runDir)),
    run: path.basename(runDir),
    finished_at: new Date().toISOString(),
    exit: null,
    status: 'FAIL',
    reason: line(reason, 300),
    result_ok: false,
    log_bytes: size(path.join(runDir, 'raw.log')),
    tokens: null,
    tokens_reported: false,
    model: null,
    sandbox: null,
    session_id: null,
    env: readJson(path.join(runDir, 'env.json')),
  };
  fs.writeFileSync(path.join(runDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  writeStatus(runDir, { state: 'failed', status: 'FAIL', finished_at: meta.finished_at });
  const reply = [`FAIL — ${meta.reason}`, ...extraLines, `Run: ${runDir}`].join('\n');
  return { meta, reply };
}
