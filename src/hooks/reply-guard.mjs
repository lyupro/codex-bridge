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
import { readJsonFileSync } from '../json-file.mjs';
import { resolveProjectRunsDir } from '../runner/project-dir.mjs';
import { runsRoot } from '../runner/runs-root.mjs';
import { isPidAlive, liveRuns, normalizePath, recentRuns } from './live-runs.mjs';
import { FORM, MAX_STATE_BLOCKS, STATE, takeTry } from './guard-tries.mjs';

const HOME = os.homedir();
const LOG_DIR = path.join(HOME, '.claude', 'logs');
const GUARDED = new Set(['codex-scout', 'codex-build', 'codex-review']);
const STATUSES = ['OK', 'FAIL', 'LIMIT'];

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

/**
 * Either line names the run folder. `RUN=` is printed by the call that starts a run, `ATTACH=`
 * by the repeat that joins it — and since the launcher stopped waiting, the reply carrying the
 * verdict is the stdout of the attaching call. Matching only `RUN=` would block every honest
 * answer given under the new contract as "did not delegate at all".
 */
const cleanRunDir = (value) => value.trim().replace(/\s+started=\S*$/, '').replace(/[`"'*]+$/g, '');
const runDirs = [...reply.matchAll(/(?:RUN|ATTACH)=(.+?)(?:\r?\n|$)/g)].map((match) => cleanRunDir(match[1]));

/**
 * Does this reply pronounce a verdict at all? Computed here rather than after meta.json is read,
 * because it decides whether an unnamed folder is worth searching the disk for.
 *
 * Not every honest reply carries one. The runner refuses before creating a folder — a repeat
 * without `--continue`, an impossible `--scope`, a missing `--question` — and its refusal is the
 * whole truthful answer, with no run to name. Escalating those would punish the dispatcher for
 * quoting the runner correctly, and on 2026-08-14 two such refusals arrived in a row.
 */
const claimed = STATUSES.find((status) => new RegExp(`(^|\\n)\\s*\`*${status}\\b`).test(reply));
let runDir = runDirs[0] || null;
let discoveredRun = false;
let discoveredStatus = null;
let searchedRunsDir = null;

if (runDir && !fs.existsSync(runDir)) {
  blockForm(
    'Contract violated: the response has no RUN= or ATTACH= line with an existing run folder, so ' +
      'delegation to Codex is not confirmed. Run run-codex.mjs and return its stdout ' +
      'verbatim — the ATTACH=<path> line and the status block below it. If no run occurred, ' +
      'report the runner status: your own analysis instead of Codex is prohibited in all outcomes.',
  );
}

/**
 * The text the operator reads when the state budget is gone. Everything in it is quoted
 * from status.json — the operator is being told to stop, and a stop justified by guesswork
 * is a stop he learns to ignore. `fact` names the missing field instead of inventing one.
 */
const fact = (value) => (value === undefined || value === null || value === '' ? 'not recorded' : String(value));

const stopText = (headline, observed, runStatus, folder = runDir) => {
  if (!runStatus) {
    return [headline, observed, `Project runs directory checked: ${folder || 'not recorded'}.`].join(' ');
  }
  if (runStatus.state === 'finished' || runStatus.state === 'failed') {
    return [
      headline,
      `Run: slug ${fact(runStatus.slug)}, agent ${fact(runStatus.agent)}, repository ` +
        `${fact(runStatus.repo)}, started ${fact(runStatus.started_at)}.`,
      `Run folder: ${folder}. Read state from ${path.join(folder, 'status.json')} and verdict ` +
        `from ${path.join(folder, 'meta.json')}.`,
      observed,
      'The recorded run is complete; return the runner artifacts verbatim instead of replacing ' +
        'their verdict or omitting their folder.',
    ].join(' ');
  }
  return [
    headline,
    `Run: slug ${fact(runStatus?.slug)}, agent ${fact(runStatus?.agent)}, repository ` +
      `${fact(runStatus?.repo)}, started ${fact(runStatus?.started_at)}.`,
    `Run folder: ${folder}. Read state from ${path.join(folder, 'status.json')}; the verdict ` +
      'will appear in the adjacent meta.json.',
    observed,
    `Worktree ${fact(runStatus?.repo)} is busy with this run: do not build, test, or commit until ` +
      'status.json changes state to finished or failed. The runner snapshots the tree before ' +
      'and after the run and will claim any changes made during this window.',
    'The run will close itself: the worker outlives every caller and completes meta.json and ' +
      'status.json without the dispatcher. Wait for state to change and reread status.json — the ' +
      'verdict will be there; there is no need to ask the dispatcher again. Repeating the same ' +
      'command with the same --order-id attaches to this run rather than starting another.',
  ].join(' ');
};

if (!runDir && !claimed) {
  // A reply that pronounces nothing cannot contradict the disk. It stays on the old, softer path:
  // three tries about the SHAPE of the answer and then through, which is what a quoted refusal
  // needs. Only a reply that hands down a verdict earns the disk search below.
  blockForm(
    'Contract violated: the response has no RUN= or ATTACH= line, so delegation to Codex is not ' +
      'confirmed. Run run-codex.mjs and return its stdout verbatim. If the runner refused before ' +
      'creating a folder, return that refusal exactly as printed.',
  );
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
      'Contract violated: the response has no RUN= or ATTACH= line, and no recent run for this ' +
        'dispatcher was found on disk. Run run-codex.mjs and return its stdout verbatim; your own ' +
        'analysis instead of Codex is prohibited in all outcomes.',
      stopText(
        `The reply guard stopped the session: the dispatcher responded ${MAX_STATE_BLOCKS} times ` +
          'without naming a run and no recent matching run was found on disk.',
        `No run for agent ${input.agent_type} was found in the last 24 hours.`,
        null,
        searchedRunsDir,
      ),
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
    `Contract violated: the response names ${runDir} but omits live run folder ${dir}; report every `
      + `live run with its agent ${status.agent}, slug ${status.slug}, and repository ${status.repo}.`,
    stopText(
      `The reply guard stopped the session: the dispatcher responded ${MAX_STATE_BLOCKS} times `
        + 'while a live sibling Codex run was omitted from its reply.',
      `status.json in ${dir} says state=running; process pid ${fact(status.pid)} is alive.`,
      status,
      dir,
    ),
  );
}

/**
 * status.json is written by run-codex.mjs before meta.json exists, so it catches the
 * dispatcher that reports before its own run is done — meta.json alone cannot, because a
 * run in progress simply has none yet, same as a run that was never started. Runs from
 * before status.json existed have none: behave exactly as before (meta.json decides).
 */
const statusPath = path.join(runDir, 'status.json');
if (fs.existsSync(statusPath)) {
  let runStatus = null;
  try {
    runStatus = readJsonFileSync(statusPath);
  } catch {
    runStatus = null;
  }
  if (runStatus?.state === 'running') {
    if (isPidAlive(runStatus.pid)) {
      blockState(
        'Contract violated: status.json says state=running and the process is alive — the run is ' +
          'not finished, but you are already responding. The STARTED output of the starting call ' +
          'is not a result. Repeat the identical run-codex.mjs command, same --order-id, with ' +
          'timeout 1800000: it attaches to this same run, costs no quota, and prints the verdict.',
        stopText(
          `The reply guard stopped the session: the dispatcher responded ${MAX_STATE_BLOCKS} ` +
            'times while the Codex run was still in progress.',
          `status.json currently says state=running; process pid ${fact(runStatus.pid)} is alive.`,
          runStatus,
        ),
      );
    }
    if (!fs.existsSync(path.join(runDir, 'meta.json'))) {
      blockState(
        'Contract violated: status.json says state=running, but the process with this pid is dead ' +
          'and meta.json is missing — the run is abandoned. Repeat the identical run-codex.mjs ' +
          'command, same --order-id, with timeout of at least 1800000 and return its stdout ' +
          'verbatim.',
        stopText(
          `The reply guard stopped the session: the dispatcher responded ${MAX_STATE_BLOCKS} ` +
            'times for a run it did not complete.',
          `status.json currently says state=running, but process pid ${fact(runStatus.pid)} is ` +
            'dead and meta.json is missing: an interrupted Bash call killed the runner. Codex ' +
            'survives the runner and keeps editing the tree — in run 2026-07-31_114736, changes ' +
            'in 11+ files survived while no run artifact and no meta.json were ever recorded.',
          runStatus,
        ),
      );
    }
  } else if (runStatus?.state === 'abandoned') {
    blockState(
      'Contract violated: status.json says state=abandoned — the runner died without a verdict. ' +
        'Repeat the identical run-codex.mjs command, same --order-id, with timeout of at least ' +
        '1800000 and return its stdout verbatim.',
      stopText(
        `The reply guard stopped the session: the dispatcher responded ${MAX_STATE_BLOCKS} ` +
          'times for an abandoned run.',
        `status.json currently says state=abandoned (${fact(runStatus.abandoned_reason)}, ` +
          `${fact(runStatus.abandoned_at)}): the runner died without recording a verdict. Codex ` +
          'survives the runner and keeps editing the tree — in run 2026-07-31_114736, changes in ' +
          '11+ files survived while no run artifact and no meta.json were ever recorded.',
        runStatus,
      ),
    );
  }
}

const metaPath = path.join(runDir, 'meta.json');
if (!fs.existsSync(metaPath)) {
  const reason = `Contract violated: run folder ${runDir} has no meta.json; nothing supports the ` +
    'response. Run run-codex.mjs again and return its stdout verbatim.';
  if (discoveredRun) {
    blockState(
      reason,
      stopText(
        `The reply guard stopped the session: the dispatcher responded ${MAX_STATE_BLOCKS} times ` +
          'without naming the recent run found on disk.',
        `status.json says state=${fact(discoveredStatus?.state)}, status=${fact(discoveredStatus?.status)}, ` +
          'but the adjacent meta.json is missing.',
        discoveredStatus,
      ),
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
  const reason = `Contract violated: you reported ${claimed}, but run folder ${runDir} has ` +
    `state=${fact(discoveredStatus?.state)} in status.json and status=${meta.status} in meta.json ` +
    `(${meta.reason || 'no reason given'}). The runner calculates status from artifacts — return ` +
    'its output verbatim without substituting your own judgment.';
  if (discoveredRun) {
    blockState(
      reason,
      stopText(
        `The reply guard stopped the session: the dispatcher contradicted the recent run on disk ` +
          `${MAX_STATE_BLOCKS} times.`,
        `status.json says state=${fact(discoveredStatus.state)}, status=${fact(discoveredStatus.status)}; ` +
          `meta.json says status=${meta.status}, but the reply says ${claimed}.`,
        discoveredStatus,
      ),
    );
  }
  blockForm(reason);
}

if (discoveredRun) {
  blockState(
    `Contract violated: the response omitted RUN=${runDir}; status.json says ` +
      `state=${fact(discoveredStatus.state)}, status=${fact(discoveredStatus.status)}, and meta.json ` +
      `says status=${fact(meta.status)}. Return the runner stdout verbatim.`,
    stopText(
      `The reply guard stopped the session: the dispatcher omitted the recent run found on disk ` +
        `${MAX_STATE_BLOCKS} times.`,
      `status.json says state=${fact(discoveredStatus.state)}, status=${fact(discoveredStatus.status)}; ` +
        `meta.json says status=${fact(meta.status)}.`,
      discoveredStatus,
    ),
  );
}

pass();
