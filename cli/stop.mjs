/** Stops a live run and records the same abandoned FAIL artifacts as the normal unlock. */
import path from 'node:path';
import { stopCodex } from '../src/runner/codex-cmd.mjs';
import { git, worktreeSnapshot } from '../src/runner/git-state.mjs';
import {
  IDENTITY_ALIVE,
  IDENTITY_FOREIGN,
  IDENTITY_UNVERIFIED,
  processAlive,
  processIdentity,
} from '../src/process-identity.mjs';
import { markAbandoned, readJson } from '../src/write-meta.mjs';
import { runsRoot } from '../src/runner/runs-root.mjs';
import { resolveRunFolder } from './run-lookup.mjs';

const EXIT_POLL_MS = 25;
const EXIT_WAIT_MS = 2000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The stopped run's worktree as it stands now, or undefined when the repo is not a git one. */
function treeOf(repo) {
  const root = String(repo ?? '').trim();
  if (!root) return undefined;
  if (git(root, ['rev-parse', '--show-toplevel']).status !== 0) return undefined;
  return worktreeSnapshot(root);
}

function processHandle(pid) {
  return {
    pid,
    kill(signal) {
      try {
        process.kill(pid, signal);
      } catch (err) {
        if (err.code !== 'ESRCH') throw err;
      }
    },
  };
}

async function waitForExit(pid) {
  const deadline = Date.now() + EXIT_WAIT_MS;
  while (processAlive(pid) && Date.now() < deadline) await sleep(EXIT_POLL_MS);
  return !processAlive(pid);
}

function result(exitCode, output) {
  return { exitCode, output };
}

export async function stop({
  run,
  cwd = process.cwd(),
  runsRootPath = runsRoot(),
  commandRunner,
} = {}) {
  const lookup = resolveRunFolder({ command: 'stop', run, cwd, runsRootPath });
  if (lookup.error) return result(1, lookup.error);
  const { runDir } = lookup;

  const status = readJson(path.join(runDir, 'status.json'));
  const meta = readJson(path.join(runDir, 'meta.json'));
  if (meta && typeof meta.status === 'string') {
    return result(0, `Run ${runDir} already has a verdict (${meta.status}); no changes made.`);
  }
  if (!status) return result(1, `Run ${runDir} has no readable status.json; it was not changed.`);
  if (status.state !== 'running') {
    return result(0, `Run ${runDir} is not marked running (state: ${status.state || 'unknown'}); no changes made.`);
  }
  if (!Number.isInteger(status.pid) || status.pid <= 0) {
    return result(1, `Run ${runDir} has no valid recorded pid; it was not changed.`);
  }

  const identity = processIdentity({ runDir, status, commandRunner });
  if (identity === IDENTITY_UNVERIFIED || identity === IDENTITY_FOREIGN) {
    return result(
      1,
      `Process identity could not be confirmed for run ${runDir} (${identity}); no signal was sent. ` +
        '"codex-bridge unlock" closes the record without killing a process.',
    );
  }

  if (identity === IDENTITY_ALIVE) {
    try {
      stopCodex(processHandle(status.pid));
      if (!(await waitForExit(status.pid))) {
        return result(1, `Run ${runDir} did not stop within ${EXIT_WAIT_MS}ms; it was not closed.`);
      }
    } catch (err) {
      return result(1, `Could not stop run ${runDir}: ${err.message}; it was not closed.`);
    }
  }

  // The snapshot is what turns the verdict from a bare label into a list of what the stopped run
  // left in the worktree. Omitting it would close the folder with "no file list is available" —
  // the operator stopping a run by hand is exactly who needs to know what it managed to write.
  markAbandoned(path.dirname(runDir), treeOf(status.repo));
  const closedMeta = readJson(path.join(runDir, 'meta.json'));
  const closedStatus = readJson(path.join(runDir, 'status.json'));
  if (closedMeta?.status === 'FAIL' && closedStatus?.status === 'FAIL' && closedStatus.state !== 'running') {
    return result(0, `Stopped run ${runDir}; recorded FAIL verdict.`);
  }
  return result(1, `Run ${runDir} stopped but could not be closed with consistent FAIL artifacts.`);
}
