#!/usr/bin/env node
/**
 * Turns one Codex run directory into accounting plus a verdict:
 *   node write-meta.mjs <runDir> <agent> <exitCode>
 *
 * This is the only entry point that reads a run's artifacts. It writes meta.json — quota
 * accounting that survives deletion of the gitignored raw.log — and derives the run
 * status from what is actually on disk: exit code, log size, result file, git state.
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
import { writeStatus } from './meta/run-state.mjs';
import { resolveStatus } from './meta/verdict.mjs';
import { AGENTS, failReply, limitReply } from './meta/reply.mjs';

export { expandDeclared, globToRegExp, readJson } from './meta/paths.mjs';
export { chainBaseline, chainRuns, taskFingerprint } from './meta/chain.mjs';
export { activeRun, markAbandoned, writeFailure } from './meta/run-state.mjs';
export { outOfScope, reportVersusWork } from './meta/verdict.mjs';
export { AGENTS, writeStatus };

const BULLET_RE = /^\s*[-*]\s+/;
const NUMBERED_RE = /^\s*\d{1,2}[.)]\s+(.+)$/;

/**
 * The sub-questions an order actually asks. A scout run is graded against them, so they
 * have to be extracted the same way every time instead of living in the wording: one run
 * answered six numbered questions with a single table of coordinates, and nothing in the
 * artifacts could tell that five of them were never addressed.
 *
 * Numbered top-level items and lines ending in `?` count. Bulleted lines deliberately do
 * not: in real orders they carry links to specs, file lists and constraints, and a parser
 * that took them for questions would drown in them.
 *
 * Fewer than two hits means the order is one question — the whole task — and grading falls
 * back to demanding one substantial answer rather than per-question coverage.
 */
export function parseQuestions(taskText) {
  const found = [];
  const seen = new Set();
  for (const raw of String(taskText ?? '').split(/\r?\n/)) {
    if (BULLET_RE.test(raw)) continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const numbered = raw.match(NUMBERED_RE);
    const text = numbered ? numbered[1].trim() : trimmed.endsWith('?') ? trimmed : '';
    if (!text) continue;
    const key = text.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(text.slice(0, 300));
  }
  if (found.length < 2) return [];
  return found.map((text, i) => ({ id: `Q${i + 1}`, text }));
}

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

  const logPath = path.join(runDir, 'raw.log');
  const resultPath = path.join(runDir, cfg.result);
  const log = readText(logPath);
  const logBytes = size(logPath);
  const result = readJson(resultPath);
  const resultOk = Boolean(result) && cfg.filled(result);
  const exit = exitCode === undefined || exitCode === null ? null : Number(exitCode);

  // "tokens used" is followed by the count on the next line, with a non-breaking
  // thousands separator — strip every non-digit rather than trusting the spacing.
  const usage = [...log.matchAll(/tokens used[\r\n]+([^\r\n]+)/g)].pop();

  // `codex exec review` reports no usage at all. Null, never 0: a zero would silently
  // understate the total in /codex:usage.
  const tokens = usage ? parseInt(usage[1].replace(/\D/g, ''), 10) || null : null;

  const pick = (re) => (log.match(re) || [])[1] || null;
  const { status, reason, carried } = resolveStatus({ log, logBytes, resultOk, exit, agent, result, runDir });

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
    log_bytes: logBytes,
    tokens,
    tokens_reported: tokens !== null,
    model: pick(/^model:\s*(\S+)/m),
    sandbox: pick(/^sandbox:\s*(\S+)/m),
    // Null for runs made before env.json existed: absence is not the same as "both off".
    env: readJson(path.join(runDir, 'env.json')),
    session_id: pick(/^session id:\s*(\S+)/m),
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
