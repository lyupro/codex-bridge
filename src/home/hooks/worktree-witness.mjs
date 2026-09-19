#!/usr/bin/env node
/**
 * PostToolUse witness for shell writes into a live codex-build repository.
 *
 * A shell can write through Python, redirection, or any other command while bypassing the
 * file-tool lock. That is how the orchestrator changed CHANGELOG.md during the 2026-08-16
 * split-guard run and made an honest build appear out of scope. This hook compares the live
 * run's recorded git state with the repository after every shell tool and directs the
 * orchestrator to undo any change outside the run's declared scope.
 * The 2026-09-19 run accused itself of editing its own artifacts: the witness must use
 * the verdict's snapshot and environment split, not a second definition of changed work.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SHELL_TOOLS } from '../lib/hook-definitions.mjs';
import { parseJsonText } from '../lib/json-file.mjs';
import { splitRunChanges } from '../lib/meta/environment.mjs';
import { changedPaths } from '../lib/meta/paths.mjs';
import { outOfScope } from '../lib/meta/verdict.mjs';
import { git, worktreeSnapshot } from '../lib/runner/git-state.mjs';
import { runsRoot } from '../lib/runner/runs-root.mjs';
import { allLiveRuns, normalizePath } from './live-runs.mjs';

const SHELL_TOOL_NAMES = new Set(SHELL_TOOLS);
const pass = () => process.exit(0);

function readRequired(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

let input;
try {
  input = parseJsonText('stdin', fs.readFileSync(0, 'utf8'));
} catch {
  pass();
}

if (!input || typeof input !== 'object' || Array.isArray(input)) pass();
if (!SHELL_TOOL_NAMES.has(input.tool_name)) pass();
const cwd = normalizePath(input.cwd);
if (!cwd) pass();

let liveRuns;
try {
  liveRuns = allLiveRuns(runsRoot());
} catch {
  pass();
}
const owner = liveRuns.find(({ status }) => {
  if (status.agent !== 'codex-build') return false;
  const repository = normalizePath(status.repo);
  return Boolean(repository) && (cwd === repository || cwd.startsWith(`${repository}/`));
});
if (!owner) pass();

const { dir, status } = owner;
const beforeText = readRequired(path.join(dir, 'state-before.txt'));
const scopeText = readRequired(path.join(dir, 'scope.txt'));
if (beforeText === null || scopeText === null) pass();

let outside;
try {
  // changedPaths tolerates malformed rows; a hook must instead fail open on a damaged baseline.
  if (beforeText.split(/\r?\n/).filter(Boolean).some((row) =>
    !/^(?:\d+\t\d+|-\t-|U\t\d+)\t\S.*$/.test(row))) pass();
  const patterns = scopeText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!patterns.length) pass();
  // The shared snapshot returns empty output on git errors; do not call that a restored tree.
  const repository = git(status.repo, ['rev-parse', '--is-inside-work-tree']);
  if (repository.error || repository.status !== 0 || repository.stdout?.trim() !== 'true') pass();
  const current = worktreeSnapshot(status.repo);
  const { work } = splitRunChanges(dir, changedPaths(beforeText, current));
  outside = outOfScope(work, patterns);
} catch {
  pass();
}
if (!outside.length) pass();

const folder = path.basename(dir);
const paths = outside.join(', ');
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PostToolUse',
    additionalContext: `WORKTREE WITNESS — the run's own folder, environment paths and gitignored `
      + `files are already excluded. These are the orchestrator's own edits inside the repository `
      + `of live run folder ${dir} (agent ${status.agent}, slug ${status.slug}), outside its scope: ${paths}. `
      + `Act now: revert those paths, or run codex-bridge stop ${folder} to take the repository back `
      + `before making further changes.`,
  },
}));
