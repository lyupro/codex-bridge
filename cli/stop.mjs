/** Stops a live run and records the same abandoned FAIL artifacts as the normal sweep. */
import fs from 'node:fs';
import path from 'node:path';
import { stopCodex } from '../src/runner/codex-cmd.mjs';
import { git, worktreeSnapshot } from '../src/runner/git-state.mjs';
import { markAbandoned, readJson } from '../src/write-meta.mjs';
import { resolveProjectRunsDir } from '../src/runner/project-dir.mjs';
import { runsRoot } from '../src/runner/runs-root.mjs';

const EXIT_POLL_MS = 25;
const EXIT_WAIT_MS = 2000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function projectRoot(cwd) {
  const result = git(cwd, ['rev-parse', '--show-toplevel']);
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : cwd;
}

function resolveRunFolder(run, cwd, runsRootPath) {
  const value = String(run ?? '').trim();
  if (!value || value === '.' || value === '..') {
    throw new Error('stop requires a run folder (full path or bare folder name)');
  }
  if (path.isAbsolute(value)) return path.resolve(value);
  if (path.dirname(value) !== '.') {
    throw new Error('a bare run folder name or a full path is required');
  }
  const projectRuns = resolveProjectRunsDir(runsRootPath, projectRoot(cwd), { create: false });
  return path.join(projectRuns.dir, value);
}

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

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

async function waitForExit(pid) {
  const deadline = Date.now() + EXIT_WAIT_MS;
  while (alive(pid) && Date.now() < deadline) await sleep(EXIT_POLL_MS);
  return !alive(pid);
}

function result(exitCode, output) {
  return { exitCode, output };
}

export async function stop({ run, cwd = process.cwd(), runsRootPath = runsRoot() } = {}) {
  let runDir;
  try {
    runDir = resolveRunFolder(run, cwd, runsRootPath);
  } catch (err) {
    return result(1, `codex-bridge stop: ${err.message}`);
  }

  let isDirectory = false;
  try {
    isDirectory = fs.statSync(runDir).isDirectory();
  } catch {}
  if (!isDirectory) {
    return result(
      1,
      `Run folder not found: ${runDir}. Pass a full path or a bare run folder name from the current project's runs directory.`,
    );
  }

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

  try {
    stopCodex(processHandle(status.pid));
    if (!(await waitForExit(status.pid))) {
      return result(1, `Run ${runDir} did not stop within ${EXIT_WAIT_MS}ms; it was not closed.`);
    }
  } catch (err) {
    return result(1, `Could not stop run ${runDir}: ${err.message}; it was not closed.`);
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
