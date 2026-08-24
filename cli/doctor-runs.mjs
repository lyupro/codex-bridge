/** Reports the state of run storage on this machine: location, live count, retention. */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readRunConfig, retentionNotice } from '../src/home/lib/run-config.mjs';
import { runsRoot } from '../src/home/lib/runner/runs-root.mjs';
import { resolveProjectRunsDir } from '../src/home/lib/runner/project-dir.mjs';
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
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  return top.status === 0 && top.stdout.trim() ? top.stdout.trim() : cwd;
}

/**
 * A marker that cannot be read is exactly what doctor exists to report, so it is caught here.
 * Left to propagate it would kill the whole diagnosis and hide the seven checks around it.
 */
export function projectRunsCheck() {
  let resolved;
  try {
    resolved = resolveProjectRunsDir(runsRoot(), repoRoot(process.cwd()), { create: false });
  } catch (err) {
    return check('projectRuns', 'fail', err.message);
  }
  const note = resolved.reason === 'created' ? 'not created yet' : resolved.reason;
  return check('projectRuns', 'ok', `${path.resolve(resolved.dir)} (${note})`);
}

export function liveRunsCheck() {
  let count;
  try {
    count = allLiveRuns(runsRoot(), { requireConfirmedIdentity: true }).length;
  } catch (err) {
    return check('liveRuns', 'warn', `working-run count unavailable: ${err.message}`);
  }
  if (!count) return check('liveRuns', 'ok', '0 runs working right now');
  const noun = count === 1 ? 'run' : 'runs';
  return check('liveRuns', 'warn', `${count} ${noun} working right now; stop with ${STOP_COMMAND_TEMPLATE}`);
}
