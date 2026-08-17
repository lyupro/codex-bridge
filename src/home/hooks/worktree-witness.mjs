#!/usr/bin/env node
/**
 * PostToolUse witness for shell writes into a live codex-build repository.
 *
 * A shell can write through Python, redirection, or any other command while bypassing the
 * file-tool lock. That is how the orchestrator changed CHANGELOG.md during the 2026-08-16
 * split-guard run and made an honest build appear out of scope. This hook compares the live
 * run's recorded git state with the repository after every shell tool and directs the
 * orchestrator to undo any change outside the run's declared scope.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SHELL_TOOLS } from '../lib/hook-definitions.mjs';
import { parseJsonText } from '../lib/json-file.mjs';
import { globToRegExp } from '../lib/meta/paths.mjs';
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

function statusMap(text) {
  if (typeof text !== 'string') return null;
  const result = new Map();
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    if (!/^.. /.test(line)) return null;
    const rawPath = line.slice(3);
    const file = rawPath.includes(' -> ') ? rawPath.slice(rawPath.lastIndexOf(' -> ') + 4) : rawPath;
    if (!file.trim()) return null;
    result.set(file, line.slice(0, 2));
  }
  return result;
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
const beforeText = readRequired(path.join(dir, 'git-before.txt'));
const scopeText = readRequired(path.join(dir, 'scope.txt'));
if (beforeText === null || scopeText === null) pass();

const before = statusMap(beforeText);
let allowed;
try {
  const patterns = scopeText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!patterns.length) pass();
  allowed = patterns.map(globToRegExp);
} catch {
  pass();
}
if (!before) pass();

let currentResult;
try {
  currentResult = spawnSync('git', ['-C', status.repo, 'status', '--porcelain'], {
    encoding: 'utf8',
  });
} catch {
  pass();
}
if (currentResult.error || currentResult.status !== 0 || typeof currentResult.stdout !== 'string') pass();
const current = statusMap(currentResult.stdout);
if (!current) pass();

const changed = [];
for (const [file, state] of current) if (before.get(file) !== state) changed.push(file);
for (const file of before.keys()) if (!current.has(file)) changed.push(file);
const outside = [...new Set(changed)].filter((file) => !allowed.some((pattern) => pattern.test(file)));
if (!outside.length) pass();

const folder = path.basename(dir);
const paths = outside.join(', ');
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PostToolUse',
    additionalContext: `WORKTREE WITNESS — act now: the shell changed paths outside the scope of `
      + `live run folder ${dir} (agent ${status.agent}, slug ${status.slug}): ${paths}. `
      + `Revert those paths now, or run codex-bridge stop ${folder} to take the repository back `
      + `before making further changes.`,
  },
}));
