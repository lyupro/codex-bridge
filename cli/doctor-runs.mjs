/** Reports the state of run storage on this machine: location, live count, retention. */
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { readRunConfig, retentionNotice } from '../src/home/lib/run-config.mjs';
import { runsRootResolution, staleOverrideRefusal } from '../src/home/lib/runner/runs-root.mjs';
import { normalizeRepoPath, resolveProjectRunsDir } from '../src/home/lib/runner/project-dir.mjs';
import { resolveBrandHome } from '../src/home/lib/brand-home.mjs';
import { allLiveRuns } from '../src/home/hooks/live-runs.mjs';
import { STOP_COMMAND_TEMPLATE } from '../src/home/lib/stop-contract.mjs';
import { check } from './doctor-format.mjs';

export function retentionCheck(host) {
  try {
    const notice = retentionNotice(readRunConfig(host.brandConfigPath));
    return check('retention', notice.enabled ? 'warn' : 'ok', notice.text);
  } catch (err) {
    return check('retention', 'fail', `invalid configuration: ${err.message}`);
  }
}

/**
 * The runner asks git for the repository root before it picks a runs folder, so doctor has to
 * ask the same question: run from `src/home/lib/runner`, a plain cwd would name the folder `runner` and
 * report a location no run will ever use.
 */
function repoRoot(cwd) {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', windowsHide: true });
  return top.status === 0 && top.stdout.trim() ? top.stdout.trim() : cwd;
}

function runsGitTop(dir) {
  if (!fs.existsSync(dir)) return null;
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8', windowsHide: true });
  return top.status === 0 && top.stdout.trim() ? top.stdout.trim() : null;
}

export function runsRootCheck(options = {}) {
  try {
    const resolution = options.resolution ?? runsRootResolution();
    const gitTop = options.gitTop ?? runsGitTop;
    const root = path.resolve(resolution.root);
    const value = root + ' (' + resolution.source + ')';
    if (resolution.staleOverride) {
      return check('runsRoot', 'fail', value + ' — ' + staleOverrideRefusal(resolution));
    }
    if (resolution.source === 'legacy') {
      return check('runsRoot', 'warn', value + ' — move pending: run codex-bridge runs move when no other project is running.');
    }
    if (resolution.source === 'moved' && fs.existsSync(resolution.legacyRoot)
      && fs.statSync(resolution.legacyRoot).isDirectory()) {
      return check('runsRoot', 'warn', value + ' — the old folder ' + resolution.legacyRoot + ' still exists; codex-bridge runs move removes it.');
    }
    const top = gitTop(root);
    if (top && normalizeRepoPath(top) !== normalizeRepoPath(root)
      && normalizeRepoPath(top) !== normalizeRepoPath(resolveBrandHome().root)) {
      return check('runsRoot', 'warn', value + ' — run records land in the git repository ' + top + ', which is not their own; they accumulate there uncommitted.');
    }
    return check('runsRoot', 'ok', value);
  } catch (err) {
    return check('runsRoot', 'fail', err.message);
  }
}

/**
 * A marker that cannot be read is exactly what doctor exists to report, so it is caught here.
 * Left to propagate it would kill the whole diagnosis and hide the seven checks around it.
 */
export function projectRunsCheck(resolution) {
  let resolved;
  try {
    resolved = resolveProjectRunsDir(resolution.root, repoRoot(process.cwd()), { create: false });
  } catch (err) {
    return check('projectRuns', 'fail', err.message);
  }
  const note = resolved.reason === 'created' ? 'not created yet' : resolved.reason;
  return check('projectRuns', 'ok', `${path.resolve(resolved.dir)} (${note})`);
}

export function liveRunsCheck(resolution) {
  let count;
  try {
    count = allLiveRuns(resolution.root, { requireConfirmedIdentity: true }).length;
  } catch (err) {
    return check('liveRuns', 'warn', `working-run count unavailable: ${err.message}`);
  }
  if (!count) return check('liveRuns', 'ok', '0 runs working right now');
  const noun = count === 1 ? 'run' : 'runs';
  return check('liveRuns', 'warn', `${count} ${noun} working right now; stop with ${STOP_COMMAND_TEMPLATE}`);
}
