#!/usr/bin/env node
/**
 * PreToolUse lock for file tools and plainly recognisable shell writes in the Claude Code host.
 *
 * A live codex-build runner snapshots its repository before and after editing. Letting the
 * orchestrator write during that window folds unrelated work into the runner's result, exactly
 * as the 2026-08-05 incident did. This hook denies only a recognised file path inside a live
 * build run's repository; every malformed or unreadable input passes so diagnostics never break
 * unrelated host work.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { formatSilence, heartbeatAge } from '../lib/heartbeat.mjs';
import { SHELL_TOOLS, WRITE_TOOLS } from '../lib/hook-definitions.mjs';
import { runsRoot } from '../lib/runner/runs-root.mjs';
import { allLiveRuns, normalizePath } from './live-runs.mjs';
import { shellWriteIntent } from './shell-write-intent.mjs';

const WRITE_TOOL_NAMES = new Set(WRITE_TOOLS);
const SHELL_TOOL_NAMES = new Set(SHELL_TOOLS);
const pass = () => process.exit(0);

let input;
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch {
  pass();
}

if (!input || typeof input !== 'object' || Array.isArray(input)) pass();
if (!WRITE_TOOL_NAMES.has(input.tool_name) && !SHELL_TOOL_NAMES.has(input.tool_name)) pass();

const toolInput = input.tool_input;
if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) pass();
let rawPaths;
if (WRITE_TOOL_NAMES.has(input.tool_name)) {
  const pathField = input.tool_name === 'NotebookEdit' ? 'notebook_path' : 'file_path';
  const rawPath = toolInput[pathField];
  if (typeof rawPath !== 'string' || !rawPath.trim()) pass();
  rawPaths = [rawPath];
} else {
  const intent = shellWriteIntent(toolInput.command);
  if (!intent.writes || !intent.paths.length) pass();
  rawPaths = intent.paths;
}

let liveRuns;
try {
  liveRuns = allLiveRuns(runsRoot());
} catch {
  pass();
}
let match;
for (const rawPath of rawPaths) {
  let targetPath;
  try {
    if (path.isAbsolute(rawPath)) targetPath = rawPath;
    else if (typeof input.cwd === 'string' && input.cwd.trim()) targetPath = path.resolve(input.cwd, rawPath);
    else continue;
  } catch {
    continue;
  }
  const target = normalizePath(targetPath);
  if (!target) continue;
  const owner = liveRuns.find(({ status }) => {
    if (status.agent !== 'codex-build') return false;
    const repository = normalizePath(status.repo);
    return Boolean(repository) && (target === repository || target.startsWith(`${repository}/`));
  });
  if (owner) {
    match = { owner, targetPath };
    break;
  }
}
if (!match) pass();

const { status, dir } = match.owner;
// A run is only ever failed for what `git status --porcelain` reports, and an ignored path never
// appears there — the witness that grades a run does not see it either. Meanwhile the working
// order for a live run is to touch exactly those files: plans and checklists live in ignored
// folders. On 2026-08-23 this guard refused four such edits in five minutes, which is worse than
// a miss: a miss has the witness behind it, a false refusal has nothing and reads as a broken
// tool. Only a proven `ignored` passes — anything else (not a repository, git absent, any other
// error) keeps the refusal, because "no proof it is ignored" is not "proof it is harmless".
const repository = normalizePath(status.repo);
const target = normalizePath(match.targetPath);
const gitMetadata = target === `${repository}/.git` || target.startsWith(`${repository}/.git/`);
if (!gitMetadata) {
  const ignored = spawnSync('git', ['-C', status.repo, 'check-ignore', '--quiet', '--', match.targetPath], {
    stdio: 'ignore',
  });
  if (ignored.status === 0) pass();
}
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: `Worktree lock denied ${input.tool_name}: ${match.targetPath} is inside repository `
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
