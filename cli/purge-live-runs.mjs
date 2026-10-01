/**
 * Answers whether any recorded Codex run may still be executing, failing closed on anything unreadable.
 *
 * Plan_65 D22 item 5: purge removes the home image a live run executes from. The hook scanner's
 * skipped read errors and fresh-heartbeat requirement cannot prove that image is unused: a hung
 * run still holds it. Purge therefore keeps uncertainty visible and uses the single liveness judge.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readJsonFileSync } from '../src/home/lib/json-file.mjs';
import { runLiveness } from '../src/home/lib/meta/run-liveness.mjs';
import { runsRoot } from '../src/home/lib/runner/runs-root.mjs';
import { STOP_COMMAND } from '../src/home/lib/stop-contract.mjs';

function recordError(unknown, file, error) {
  unknown.push({ path: file, reason: error.code || error.message });
}

// ENOENT is the only proof of absence: a root never created holds no runs, and a project folder
// pruned between the root listing and its own is gone too. Every other code stays a finding.
function readEntries(directory, unknown) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') recordError(unknown, directory, error);
    return [];
  }
}

function isDirectory(entry, file, unknown) {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    // Plan_65 D4 forbids deleting through links, not reading their run records.
    return fs.statSync(file).isDirectory();
  } catch (error) {
    if (error.code !== 'ENOENT') recordError(unknown, file, error);
    return false;
  }
}

function inspectRun(runDir, identityOptions, blocked, unknown) {
  const statusPath = path.join(runDir, 'status.json');
  let status;
  try {
    status = readJsonFileSync(statusPath);
  } catch (error) {
    // Lifecycle step 10 writes status first; old folders without it are not recorded runs.
    if (error.cause instanceof SyntaxError) {
      unknown.push({ path: statusPath, reason: 'invalid JSON' });
    } else if (error.code !== 'ENOENT') {
      recordError(unknown, statusPath, error);
    }
    return;
  }
  if (!status || typeof status !== 'object' || Array.isArray(status)) {
    unknown.push({ path: statusPath, reason: 'status.json is not a plain object' });
    return;
  }
  if (status.state !== 'running') return;
  try {
    if (runLiveness({ ...identityOptions, runDir, status }).processMayBeAlive === true) {
      blocked.push({
        runDir,
        agent: status.agent,
        slug: status.slug,
        stop: `${STOP_COMMAND} "${runDir}"`,
      });
    }
  } catch (error) {
    recordError(unknown, statusPath, error);
  }
}

export function inspectLiveRuns({ root = runsRoot(), ...identityOptions } = {}) {
  const blocked = [];
  const unknown = [];
  for (const project of readEntries(root, unknown)) {
    const projectDir = path.join(root, project.name);
    if (!isDirectory(project, projectDir, unknown)) continue;
    for (const run of readEntries(projectDir, unknown)) {
      const runDir = path.join(projectDir, run.name);
      if (isDirectory(run, runDir, unknown)) inspectRun(runDir, identityOptions, blocked, unknown);
    }
  }
  const verdict = blocked.length ? 'blocked' : unknown.length ? 'unknown' : 'clear';
  return { verdict, blocked, unknown };
}

export function liveRunLines(result) {
  if (result.verdict === 'clear') return [];
  return [
    ...result.blocked.map(({ runDir, stop }) => `Live run ${path.basename(runDir)}: ${stop}`),
    ...result.unknown.map(({ path: file, reason }) =>
      `Could not read ${file} (${reason}): purge cannot prove no run is live.`),
  ];
}

