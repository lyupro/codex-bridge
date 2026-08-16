#!/usr/bin/env node
/**
 * SubagentStop guard for the Codex dispatchers (codex-scout / codex-build / codex-review).
 *
 * Their contract is that the reply IS the runner's stdout: a `RUN=` or `ATTACH=` line naming the
 * run folder plus the status block printed by write-meta.mjs. Prose forbids anything else, and prose has been
 * ignored twice — once a dispatcher reviewed the diff itself (68k Claude tokens instead of
 * five lines), once it announced a background run that never existed. Neither is visible
 * from the reply alone, which is why this check lives outside the model.
 *
 * It blocks on substance only:
 *   - no usable `RUN=` / `ATTACH=` path in the reply (the dispatcher did not delegate at all);
 *   - status.json says the run is still going, or was abandoned, before meta.json exists;
 *   - the run folder has no meta.json (the reply rests on nothing);
 *   - the reply's status word contradicts meta.json.
 *
 * Cosmetics — code fences, blank lines, reordered whitespace — pass. Blocking those would
 * spend Claude tokens on a re-answer that changes no decision.
 *
 * Those four reasons are of two different kinds, and they get two different budgets: an
 * argument about the SHAPE of the reply can loop forever and eventually steps aside, an
 * argument about EXTERNAL run state cannot be argued away by the model and ends the turn
 * with `continue: false` instead of a silent pass. See MAX_FORM_BLOCKS / MAX_STATE_BLOCKS.
 *
 * Input is JSON on stdin. The fields used here (`agent_type`, `last_assistant_message`)
 * come from Claude Code; the last payload is kept in logs/codex-reply-guard.last.json so
 * the contract stays inspectable if it ever changes shape.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runOrderMismatch, transcriptOrderId } from '../lib/dispatcher-order.mjs';
import { recognizeHostRefusal } from '../lib/host-refusal.mjs';
import { readJsonFileSync } from '../lib/json-file.mjs';
import { resolveProjectRunsDir } from '../lib/runner/project-dir.mjs';
import { runsRoot } from '../lib/runner/runs-root.mjs';
import { isPidAlive, liveRuns, normalizePath, recentRuns } from './live-runs.mjs';
import { FORM, MAX_STATE_BLOCKS, STATE, takeTry } from './guard-tries.mjs';
import { parseReply } from './reply-parser.mjs';
import {
  abandonedRunReason,
  abandonedRunStop,
  deadRunReason,
  deadRunStop,
  liveRunReason,
  liveRunStop,
  missingDiscoveredMetaStop,
  missingHostOrderIdReason,
  missingMetaReason,
  missingRunReason,
  noRecentRunReason,
  noRecentRunStop,
  nonexistentRunReason,
  omittedDiscoveredRunReason,
  omittedDiscoveredRunStop,
  omittedSiblingReason,
  omittedSiblingStop,
  orderMismatchStop,
  statusMismatchReason,
  statusMismatchStop,
} from './reply-verdicts.mjs';

// Plan_46's first invariant recognizes only direct expressions such as
// blockForm('Contract violated: run codex-bridge run and return its stdout verbatim.');
// The broader hook-directory scan protects the extracted verdict text from the same incident.
const HOME = os.homedir();
const LOG_DIR = path.join(HOME, '.claude', 'logs');
const GUARDED = new Set(['codex-scout', 'codex-build', 'codex-review']);

/**
 * How many times a single agent may be blocked over the SHAPE of its reply — no RUN= line,
 * no meta.json, a status word that contradicts meta.json. 1 is too few: the incident that
 * prompted this constant was a dispatcher blocked once, retried, and answered wrong again
 * ("run started in background, waiting 5-10 minutes") — the old one-shot guard let that
 * second wrong answer straight through. Unbounded is worse: here the argument is with the
 * model, and a dispatcher stuck re-answering the same way loops forever and burns Claude
 * quota on retries that never converge. Three tries, then let it through so the operator
 * sees a reply with substance in it and judges for himself.
 */
/**
 * The same allowance for blocks caused by EXTERNAL state — the run is still going, or its
 * runner died. Counted separately because the two run out for unrelated reasons: three
 * malformed replies must not spend the budget that protects a live worktree, and a live
 * worktree is not something the model can answer its way out of. Exhausting this one does
 * NOT step aside — see the stopReason path below. What went through the shared budget was
 * "Waiting for the Codex run to finish... Monitor started in background. Awaiting notification",
 * promised over a run whose runner was already dead (counter a662d99e0c67d3a8a => 3): the
 * orchestrator got a promise from a process that no longer existed and never learned the
 * worktree was busy.
 */
/** Never let a guard failure break real work: on any doubt, stay silent. */
const pass = () => process.exit(0);

let input;
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch {
  pass();
}

try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(path.join(LOG_DIR, 'codex-reply-guard.last.json'), `${JSON.stringify(input, null, 2)}\n`);
} catch {
  // Diagnostics are a convenience, never a reason to fail the turn.
}

// Only the Codex dispatchers have this contract. Every other agent is none of our
// business — an earlier version inferred the agent from transcript text and blocked an
// unrelated one, which cost a re-answer for nothing.
if (!GUARDED.has(input.agent_type)) pass();

const reply = String(input.last_assistant_message || '').trim();
if (!reply) pass();
const emit = (payload) => {
  process.stdout.write(JSON.stringify(payload));
  process.exit(0);
};
/** Wrong shape of reply: three tries, then the reply goes through as it always has. */
const blockForm = (reason) => {
  if (takeTry(input.agent_id, FORM) !== 'granted') pass();
  emit({ decision: 'block', reason });
};

// The 2026-08-16 probe spent all state tries on an honest refusal; decide it before RUN/disk checks.
const hostRefusal = recognizeHostRefusal(reply);
if (hostRefusal.recognized) pass();
if (hostRefusal.declaresFailure && hostRefusal.namesInstallRemedy && !hostRefusal.namesOrderId) {
  blockForm(missingHostOrderIdReason);
}

/**
 * Wrong external state: three tries, then the turn ends with stopReason instead of the
 * silent pass. Silence here is what let a run in progress be reported as finished business
 * — the operator saw a confident reply and nothing about the worktree being occupied.
 */
const blockState = (reason, stopReason) => {
  const verdict = takeTry(input.agent_id, STATE);
  if (verdict === 'granted') emit({ decision: 'block', reason });
  if (verdict === 'exhausted') emit({ continue: false, stopReason });
  pass();
};

const { runDirs, claimed } = parseReply(reply);
let runDir = runDirs[0] || null;
let discoveredRun = false;
let discoveredStatus = null;
let searchedRunsDir = null;

if (runDir && !fs.existsSync(runDir)) {
  blockForm(nonexistentRunReason);
}

const orderedOrderId = transcriptOrderId(input.agent_transcript_path);

if (!runDir && !claimed) {
  // A reply that pronounces nothing cannot contradict the disk. It stays on the old, softer path:
  // three tries about the SHAPE of the answer and then through, which is what a quoted refusal
  // needs. Only a reply that hands down a verdict earns the disk search below.
  blockForm(missingRunReason);
}

if (!runDir) {
  let candidates;
  try {
    searchedRunsDir = resolveProjectRunsDir(runsRoot(), input.cwd, { create: false }).dir;
    candidates = recentRuns(searchedRunsDir, { agent: input.agent_type });
  } catch {
    pass();
  }
  if (candidates === null) pass();

  if (!candidates.length) {
    blockState(
      noRecentRunReason,
      noRecentRunStop(MAX_STATE_BLOCKS, input.agent_type, searchedRunsDir),
    );
  }

  ({ dir: runDir, status: discoveredStatus } = candidates[0]);
  discoveredRun = true;
}

/**
 * The dispatcher must name every WRITING run the project has live, not just the one it chose to
 * quote. The sibling scan is disk-only, so silence cannot hide a second runner; a scan failure
 * remains fail-open because an uncertain diagnostic must never deny unrelated work.
 *
 * Only codex-build counts. Scout and review run in a read-only sandbox and leave the worktree
 * alone, and launching them alongside other work is deliberate practice here — blocking a reply
 * over a live reader would spend the state budget, and possibly the session, on a run that
 * threatens nothing. What the 2026-08-05 incident cost was a hidden WRITER: the orchestrator
 * edited files that landed in its before/after snapshot.
 */
const namedRunDirs = new Set(runDirs.map((dir) => normalizePath(dir)).filter(Boolean));
let silentLiveSibling = null;
try {
  silentLiveSibling = liveRuns(path.dirname(runDir)).find((run) => {
    if (run.status.agent !== 'codex-build') return false;
    const normalized = normalizePath(run.dir);
    return normalized && !namedRunDirs.has(normalized);
  });
} catch {
  silentLiveSibling = null;
}
if (silentLiveSibling) {
  const { dir, status } = silentLiveSibling;
  blockState(
    omittedSiblingReason(runDir, dir, status),
    omittedSiblingStop(MAX_STATE_BLOCKS, dir, status),
  );
}

/**
 * status.json is written by run-codex.mjs before meta.json exists, so it catches the
 * dispatcher that reports before its own run is done — meta.json alone cannot, because a
 * run in progress simply has none yet, same as a run that was never started. Runs from
 * before status.json existed have none: behave exactly as before (meta.json decides).
 */
const statusPath = path.join(runDir, 'status.json');
let runStatus = null;
if (fs.existsSync(statusPath)) {
  try {
    runStatus = readJsonFileSync(statusPath);
  } catch {
    runStatus = null;
  }
  const mismatch = runOrderMismatch(orderedOrderId, runStatus, runDir);

  if (mismatch) {
    blockState(mismatch.reason, orderMismatchStop(MAX_STATE_BLOCKS, mismatch, runStatus, runDir));
  }

  if (runStatus?.state === 'running') {
    if (isPidAlive(runStatus.pid)) {
      blockState(
        liveRunReason,
        liveRunStop(MAX_STATE_BLOCKS, runStatus, runDir),
      );
    }

    if (!fs.existsSync(path.join(runDir, 'meta.json'))) {
      blockState(
        deadRunReason,
        deadRunStop(MAX_STATE_BLOCKS, runStatus, runDir),
      );
    }
  } else if (runStatus?.state === 'abandoned') {
    blockState(
      abandonedRunReason,
      abandonedRunStop(MAX_STATE_BLOCKS, runStatus, runDir),
    );
  }
}

const metaPath = path.join(runDir, 'meta.json');

if (!fs.existsSync(metaPath)) {
  const reason = missingMetaReason(runDir);

  if (discoveredRun) {
    blockState(
      reason,
      missingDiscoveredMetaStop(MAX_STATE_BLOCKS, discoveredStatus, runDir),
    );
  }

  blockForm(reason);
}

let meta;
try {
  meta = readJsonFileSync(metaPath);
} catch {
  pass();
}

if (claimed && meta.status && claimed !== meta.status) {
  const reason = statusMismatchReason(claimed, meta, discoveredStatus, runDir);

  if (discoveredRun) {
    blockState(
      reason,
      statusMismatchStop(MAX_STATE_BLOCKS, claimed, meta, discoveredStatus, runDir),
    );
  }

  blockForm(reason);
}

if (discoveredRun) {
  blockState(
    omittedDiscoveredRunReason(meta, discoveredStatus, runDir),
    omittedDiscoveredRunStop(MAX_STATE_BLOCKS, meta, discoveredStatus, runDir),
  );
}

pass();
