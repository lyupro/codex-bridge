#!/usr/bin/env node
/**
 * Turns one Codex run directory into accounting plus a verdict:
 *   node write-meta.mjs <runDir> <agent> <exitCode>
 *
 * This is the only entry point that reads a run's artifacts. It writes meta.json — accounting
 * for the two transport files — and derives the run status from what is actually on disk:
 * exit code, structured events, result file, git state.
 * A dispatcher agent therefore cannot report an outcome its own run does not support.
 *
 * The reply lines printed here ARE the reply. Agents forward this stdout verbatim
 * instead of composing prose, which is what keeps a delegated run at five lines.
 *
 * All three agents go through this file: accounting and verdict must not fork into
 * three slightly different copies.
 *
 * The work itself lives in meta/, one concern per module: paths.mjs reads artifacts and
 * makes two spellings of a path meet, chain.mjs finds the earlier passes of the same task,
 * run-state.mjs keeps status.json honest, verdict.mjs decides OK/FAIL/LIMIT, reply.mjs
 * renders the lines. Importers name this file and nothing below it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { changedPaths, readJson, readText, size } from './meta/paths.mjs';
import { splitRunChanges } from './meta/environment.mjs';
import { readEvents } from './meta/events.mjs';
import { writeStatus } from './meta/run-state.mjs';
import { resolveStatus } from './meta/verdict.mjs';
import { AGENTS, failReply, limitReply } from './meta/reply.mjs';

export { expandDeclared, globToRegExp, readJson } from './meta/paths.mjs';
export { chainBaseline, chainRuns, taskFingerprint } from './meta/chain.mjs';
export { abortedPreStart, startedRuns } from './meta/pre-start.mjs';
export {
  abandonedBranchDrift,
  activeRun,
  activeRunDetails,
  markAbandoned,
  writeFailure,
} from './meta/run-state.mjs';
export { outOfScope, reportVersusWork } from './meta/verdict.mjs';
export { AGENTS, writeStatus };

/**
 * Folder name a repository gets inside codex-runs. A repo whose own folder starts with a
 * dot (~/.claude, ~/.omc) would otherwise produce a hidden run folder that plain `ls` does
 * not show and that reads as a service directory rather than a project.
 */
export const projectFolder = (repoRoot) => path.basename(repoRoot).replace(/^\.+/, '') || 'repo';

/**
 * Reads the run directory, writes meta.json, returns {meta, reply}. `reply` is the
 * exact text a dispatcher is allowed to return.
 */
export function collect(runDir, agent, exitCode) {
  const cfg = AGENTS[agent];
  if (!cfg) throw new Error(`unknown agent: ${agent} (expected one of ${Object.keys(AGENTS).join(', ')})`);

  const eventsPath = path.join(runDir, 'events.jsonl');
  const stderrPath = path.join(runDir, 'stderr.log');
  const resultPath = path.join(runDir, cfg.result);
  const eventsBytes = size(eventsPath);
  const stderrBytes = size(stderrPath);
  const result = readJson(resultPath);
  const resultOk = Boolean(result) && cfg.filled(result);
  const exit = exitCode === undefined || exitCode === null ? null : Number(exitCode);
  const events = readEvents(runDir);
  const worker = readJson(path.join(runDir, 'worker.json'));

  const args = Array.isArray(worker?.args) ? worker.args : [];
  const argValue = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 && typeof args[index + 1] === 'string' ? args[index + 1] : null;
  };
  const { status, reason, carried } = resolveStatus({
    resultOk,
    exit,
    agent,
    result,
    runDir,
    events,
  });

  const meta = {
    agent,
    project: path.basename(path.dirname(runDir)),
    run: path.basename(runDir),
    finished_at: new Date().toISOString(),
    exit,
    status,
    reason,
    // An OK earned by an earlier pass of the same task reads differently from an OK earned
    // here, and accounting must not blur the two: always present, so its absence in a reply
    // is never mistaken for "false".
    carried_from_earlier_run: Boolean(carried),
    // What the tooling around the run wrote into the tree while it worked. Kept out of the
    // verdict but never out of the record: this is the audit trail for every path a pattern
    // excused, so a real edit cannot hide behind one.
    environment_changes: splitRunChanges(
      runDir,
      changedPaths(readText(path.join(runDir, 'state-before.txt')), readText(path.join(runDir, 'state-after.txt'))),
    ).environment,
    result_ok: resultOk,
    events_bytes: eventsBytes,
    stderr_bytes: stderrBytes,
    tokens: events.tokens,
    tokens_reported: events.tokens !== null,
    usage: events.usage,
    model: argValue('-m'),
    sandbox: argValue('--sandbox'),
    // Null for runs made before env.json existed: absence is not the same as "both off".
    env: readJson(path.join(runDir, 'env.json')),
    session_id: events.session_id,
  };

  fs.writeFileSync(path.join(runDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  // meta.json first, status.json after it: status only ever claims a verdict that is
  // already on disk.
  writeStatus(runDir, { state: 'finished', status, finished_at: meta.finished_at });

  const ctx = {
    runDir,
    agent,
    result,
    resultPath,
    carried: meta.carried_from_earlier_run,
    file: (name) => path.join(runDir, name),
  };
  const reply =
    status === 'OK' ? cfg.reply(ctx) : status === 'LIMIT' ? limitReply(ctx, meta) : failReply(ctx, meta);

  return { meta, reply: reply.join('\n') };
}

/** Exit code mirrors the status so an orchestrator can branch without parsing text. */
export const exitCodeFor = (status) => (status === 'OK' ? 0 : status === 'LIMIT' ? 3 : 1);

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const [runDir, agent, exitCode] = process.argv.slice(2);
  if (!runDir || !agent) {
    console.error('usage: node write-meta.mjs <runDir> <agent> <exitCode>');
    process.exit(1);
  }
  const { meta, reply } = collect(runDir, agent, exitCode);
  console.log(reply);
  process.exit(exitCodeFor(meta.status));
}
