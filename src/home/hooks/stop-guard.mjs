import fs from 'node:fs';
import path from 'node:path';
import { STOP_TOOLS } from '../lib/hook-definitions.mjs';
import { runsRoot } from '../lib/runner/runs-root.mjs';
import { renderStopCommand, STOP_REASON } from '../lib/stop-contract.mjs';
import { allLiveRuns, normalizePath } from './live-runs.mjs';
import { takeTry } from './guard-tries.mjs';

/**
 * Plan_31 catches TaskStop killing the dispatcher wrapper while the runner keeps writing. It
 * must stay silent on malformed input or uncertain liveness, and the second denial budget keeps
 * an unrelated host task from becoming impossible to stop.
 */

const pass = () => process.exit(0);
const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

function readInput() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
}

function runForRepository(cwd) {
  const repository = normalizePath(cwd);
  if (!repository) return null;

  let live;
  try {
    live = allLiveRuns(runsRoot(), { requireConfirmedIdentity: true });
  } catch {
    return null;
  }

  return live
    .filter(({ status }) => {
      const runRepository = normalizePath(status.repo);
      return runRepository === repository || repository.startsWith(`${runRepository}/`);
    })
    .sort(({ status: left }, { status: right }) => right.repo.length - left.repo.length)[0] ?? null;
}

function deny(run) {
  const runName = path.basename(run.dir);
  // Key by run folder: the host task_id can belong to an unrelated background build, so it cannot
  // safely identify the dispatcher this guard just warned about.
  if (takeTry(normalizePath(run.dir), 'stop', 1) !== 'granted') pass();

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `TaskStop denied: live run ${runName} is working. `
        + `Use ${renderStopCommand(runName)}. ${STOP_REASON}`,
    },
  }));
}

const input = readInput();
if (!isObject(input) || !STOP_TOOLS.includes(input.tool_name)) pass();
if (!isObject(input.tool_input) || typeof input.tool_input.task_id !== 'string' || !input.tool_input.task_id) {
  pass();
}
if (typeof input.cwd !== 'string' || !input.cwd) pass();

const run = runForRepository(input.cwd);
if (!run) pass();
deny(run);
