#!/usr/bin/env node
/**
 * PreToolUse lock for file-writing tools in the Claude Code host.
 *
 * A live codex-build runner snapshots its repository before and after editing. Letting the
 * orchestrator write during that window folds unrelated work into the runner's result, exactly
 * as the 2026-08-05 incident did. This hook denies only a recognised file path inside a live
 * build run's repository; every malformed or unreadable input passes so diagnostics never break
 * unrelated host work.
 */
import fs from 'node:fs';
import path from 'node:path';
import { formatSilence, heartbeatAge } from '../heartbeat.mjs';
import { WRITE_TOOLS } from '../hook-definitions.mjs';
import { runsRoot } from '../runner/runs-root.mjs';
import { allLiveRuns, normalizePath } from './live-runs.mjs';

const WRITE_TOOL_NAMES = new Set(WRITE_TOOLS);
const pass = () => process.exit(0);

let input;
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch {
  pass();
}

if (!input || typeof input !== 'object' || Array.isArray(input)) pass();
if (!WRITE_TOOL_NAMES.has(input.tool_name)) pass();

const toolInput = input.tool_input;
if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) pass();
const pathField = input.tool_name === 'NotebookEdit' ? 'notebook_path' : 'file_path';
const rawPath = toolInput[pathField];
if (typeof rawPath !== 'string' || !rawPath.trim()) pass();

let targetPath;
try {
  if (path.isAbsolute(rawPath)) targetPath = rawPath;
  else if (typeof input.cwd === 'string' && input.cwd.trim()) targetPath = path.resolve(input.cwd, rawPath);
  else pass();
} catch {
  pass();
}

const target = normalizePath(targetPath);
if (!target) pass();

let liveRuns;
try {
  liveRuns = allLiveRuns(runsRoot());
} catch {
  pass();
}
const owner = liveRuns.find(({ status }) => {
  if (status.agent !== 'codex-build') return false;
  const repository = normalizePath(status.repo);
  return Boolean(repository) && (target === repository || target.startsWith(`${repository}/`));
});
if (!owner) pass();

const { status, dir } = owner;
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: `Worktree lock denied ${input.tool_name}: ${targetPath} is inside repository `
      + `${status.repo}, held by live run folder ${dir} (agent ${status.agent}, slug ${status.slug}). `
      // "Working, last progress X ago" rather than "silent for X": this hook only ever denies a
      // run whose heartbeat is still fresh — a stale one is not live here and the edit passes. The
      // first live probe printed "silent for 10 seconds" next to a stop command on a perfectly
      // healthy run, which reads as "it hung, kill it" and would cost the operator 20 minutes of
      // work they meant to keep.
      + `It is working; last progress ${formatSilence(heartbeatAge(dir))} ago. `
      + `To take the repository back before it finishes: codex-bridge stop ${path.basename(dir)}.`,
  },
}));
