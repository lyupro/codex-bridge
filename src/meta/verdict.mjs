/**
 * Derives a run's status from what its artifacts prove, never from what the run claims.
 *
 * Exit code, log size, result file, the worktree either side of the run, HEAD either side
 * of it, and the sub-questions the order asked — a dispatcher agent therefore cannot report
 * an outcome its own run does not support. Every branch in resolveStatus() exists because
 * a real run satisfied every schema while doing something other than the job.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  SERVICE_RE,
  changedPaths,
  declaredHits,
  expandDeclared,
  globToRegExp,
  line,
  normalizePath,
  readJson,
  readText,
} from './paths.mjs';
import { chainBaseline } from './chain.mjs';
import { splitRunChanges } from './environment.mjs';

/**
 * Quota exhaustion is a transport error, not a word. Both markers must sit on the same
 * line: a run whose review text merely discusses "quota exhaustion" is not a run that
 * hit the quota, and reporting LIMIT there tells the orchestrator not to retry when it
 * should. "try again later" is deliberately absent — it is a transient-failure phrase,
 * not a quota one.
 */
const LIMIT_RE = /rate.?limit|usage limit|usage_limit|quota exceeded|quota exhausted|too many requests|\b429\b/i;
const ERROR_RE = /\bERROR\b|error[:=]|stream error|"status"\s*:\s*429|rejected|refused|failed/i;

// How much prose an answer must carry once coordinates and paths are subtracted. Measured
// on the scout run of 2026-07-30 that replied with a table of `file.ts:60-79` rows: every
// one of its six sub-answers scored under 30, while the shortest honest explanation of a
// single mechanism in the same report scored above 120. 80 is one full sentence; 200 is
// the single-question mode, where one question means the whole answer is the essay.
const MIN_SUBSTANCE_CHARS = 80;
const MIN_SINGLE_SUBSTANCE_CHARS = 200;

/**
 * The honest reason for a failure. Codex prints API errors as pretty-printed JSON, so
 * the literally-last line is often just `}` — useless in a one-line reply. Prefer the
 * error message field, then any error line, then the last line that carries text.
 */
const reasonFrom = (log) => {
  const messages = [...log.matchAll(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/g)];
  if (messages.length) return line(messages[messages.length - 1][1].replace(/\\"/g, '"'));
  const lines = log.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const errorLine = [...lines].reverse().find((l) => /error|failed|denied|refused/i.test(l));
  return line(errorLine || lines[lines.length - 1] || '');
};

const limitSignal = (log) => {
  const hit = log.split(/\r?\n/).find((l) => LIMIT_RE.test(l) && ERROR_RE.test(l));
  return hit ? line(hit) : null;
};

/**
 * Which touched paths the task never authorised. The scope exists because prose does not
 * bind: one build run was told in words to keep away from `!Plans/*.md` and edited them
 * anyway, and nothing in the artifacts objected — reportVersusWork() only needs a single
 * declared path to match the tree, so extra files were never looked at.
 *
 * Service directories are outside every scope by construction: no task grants a delegated
 * run the right to edit `.git/` or `.claude/`, so no pattern can whitelist them.
 */
export function outOfScope(touchedPaths, patterns) {
  const allowed = (patterns || []).filter(Boolean).map(globToRegExp);
  const bad = [];
  for (const raw of touchedPaths || []) {
    const file = normalizePath(raw);
    if (!file) continue;
    if (SERVICE_RE.test(file)) {
      bad.push(file);
      continue;
    }
    if (!allowed.length) continue;
    if (!allowed.some((re) => re.test(file))) bad.push(file);
  }
  return bad;
}

/** Reserved for verdicts where the work really was the wrong work, not for check artefacts. */
const WRONG_WORK = 'wrong work was done: ';

/**
 * Does the report describe the work that actually happened? A schema cannot answer this:
 * a well-formed report about unrelated work is indistinguishable from a well-formed
 * report about the job. The worktree can — it was snapshotted either side of the run.
 *
 * The report describes the state of the TASK, so it is matched against the run's own delta
 * first and against the whole chain's accumulated work second (baseline of the first run ->
 * this run's "after"). A second pass that legitimately changed little is carried, not
 * failed. Both sides empty stays agreement: "there was nothing to change" is a legitimate
 * outcome, and failing it would punish the one honest way to say so.
 */
export function reportVersusWork(runDir, result, ctx) {
  const declared = (result?.changes || []).flatMap((c) => expandDeclared(c?.file));
  const after = readText(path.join(runDir, 'state-after.txt'));
  // Only the run's own work is compared: a report that names nothing is honest when the sole
  // change in the tree was written by the tooling around the run.
  const touched = splitRunChanges(
    runDir,
    changedPaths(readText(path.join(runDir, 'state-before.txt')), after),
  ).work;
  const show = (list) => list.slice(0, 3).join(', ');
  const agreed = (carried = false) => ({ ok: true, carried, reason: null });
  const broken = (reason) => ({ ok: false, carried: false, reason });

  if (!declared.length && !touched.length) return agreed();
  if (!declared.length) {
    return broken(
      `${WRONG_WORK}tree changed (${touched.length}: ${show(touched)}), but the report names no changes`,
    );
  }
  if (declared.some((d) => declaredHits(d, touched))) return agreed();

  // Ahead of the chain lookup: no earlier pass of any task grants the right to edit `.git/`
  // or `.claude/`, so finding such a path in the chain would excuse the one thing that is
  // never excusable.
  const service = declared.filter((f) => SERVICE_RE.test(f));
  if (service.length) {
    return broken(
      `${WRONG_WORK}report describes work in service directories (${show(service)}), not task files`,
    );
  }

  const baseline = chainBaseline(ctx?.runsRoot, ctx?.repo, ctx?.slug, ctx?.taskHash);
  if (baseline !== null) {
    const accumulated = splitRunChanges(runDir, changedPaths(baseline, after)).work;
    if (declared.some((d) => declaredHits(d, accumulated))) return agreed(true);
  }

  return broken(
    touched.length
      ? `${WRONG_WORK}report names ${show(declared)}, but ${show(touched)} changed`
      : 'run did not change the tree, and earlier runs of this task do not contain the declared files',
  );
}

/**
 * Which task a run belongs to, for the chain lookup. status.json is written before Codex is
 * even probed, so repo and slug are on disk by the time a verdict is computed; a run from
 * before status.json existed yields an empty context, and the chain is then not guessed.
 */
const chainContextOf = (runDir) => {
  const status = readJson(path.join(runDir, 'status.json')) || {};
  return {
    runsRoot: path.dirname(runDir),
    repo: status.repo || '',
    slug: status.slug || '',
    // Runs from before the fingerprint existed carry no hash; they chain by slug as they did.
    taskHash: status.task_hash || '',
  };
};

/**
 * How much of an answer is prose rather than a map. Coordinates (`path/to/file.ts:12-40`,
 * `foo.ts:88`) and bare paths are subtracted first, then punctuation and spacing, because a
 * "scout" that returns nothing but a coordinate table is the exact failure this measures
 * — and by character count that table is long.
 */
function substanceLength(text) {
  return String(text ?? '')
    .replace(/`+/g, ' ')
    .replace(/\S*\.[A-Za-z0-9]+:\d+(?:\s*[-– — ]\s*\d+)?/g, ' ')
    .replace(/\S*[\\/]\S*/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '').length;
}

const questionsOf = (runDir) => {
  const parsed = readJson(path.join(runDir, 'questions.json'));
  return Array.isArray(parsed) ? parsed.filter((q) => q && q.id) : [];
};

/** Answers indexed by question id, first one wins; ids come back in whatever case Codex used. */
const answersById = (result) => {
  const map = new Map();
  for (const answer of Array.isArray(result?.answers) ? result.answers : []) {
    const id = String(answer?.question_id || '').trim().toUpperCase();
    if (id && !map.has(id)) map.set(id, answer);
  }
  return map;
};

/**
 * Why a scout run is not done. Coverage is checked against questions.json when the order had
 * several questions; otherwise the single answer has to carry the analysis by itself. Every
 * branch here exists because a schema alone accepted the run that answered in coordinates.
 */
function scoutCoverageGap(runDir, result) {
  const questions = questionsOf(runDir);
  const show = (list) => list.slice(0, 8).join(', ');

  if (!questions.length) {
    const chars = substanceLength(result?.answer);
    if (chars < MIN_SINGLE_SUBSTANCE_CHARS) {
      return `response without analysis: ${chars} substantive characters, minimum ` +
        `${MIN_SINGLE_SUBSTANCE_CHARS} (coordinates and paths excluded)`;
    }
    return null;
  }

  const byId = answersById(result);
  const missing = questions
    .filter((q) => !String(byId.get(q.id)?.answer || '').trim())
    .map((q) => q.id);
  if (missing.length) {
    return `scout did not answer ${missing.length} sub-questions: ${show(missing)}`;
  }

  const thin = questions
    .filter((q) => substanceLength(byId.get(q.id).answer) < MIN_SUBSTANCE_CHARS)
    .map((q) => q.id);
  if (thin.length) return `response to ${show(thin)} contains coordinates without analysis`;

  const unsourced = questions
    .filter((q) => !(byId.get(q.id).evidence || []).some((e) => String(e || '').trim()))
    .map((q) => q.id);
  if (unsourced.length) return `responses without a single code reference: ${show(unsourced)}`;

  return null;
}

/** `6/6 sub-questions`, or null when the order asked one question and coverage means nothing. */
export function scoutCoverage(runDir, result) {
  const questions = questionsOf(runDir);
  if (!questions.length) return null;
  const byId = answersById(result);
  const answered = questions.filter((q) => String(byId.get(q.id)?.answer || '').trim()).length;
  return `${answered}/${questions.length} sub-questions`;
}

/**
 * A commit made under an explicit ban. HEAD is snapshotted either side of the run, so this
 * is a fact rather than an interpretation: one build run went to commit while the task said
 * not to, and only the sandbox (a read-only `.git`) stopped it — the contract said nothing.
 */
function commitDuringRun(runDir) {
  const before = readText(path.join(runDir, 'head-before.txt')).trim();
  const after = readText(path.join(runDir, 'head-after.txt')).trim();
  if (!before || !after || before === after) return null;
  return `commit made despite prohibition: ${before.slice(0, 12)} → ${after.slice(0, 12)}`;
}

/**
 * A branch moved under an explicit ban. Branch names are snapshotted either side of the run,
 * so the artifacts prove whether it stayed on the same ref or left the repository detached.
 *
 * Existence is checked rather than emptiness, because here an empty file is data — detached
 * HEAD — and a missing one is silence. Both snapshots have to be present for the comparison
 * to mean anything: a run whose launcher predates this check, or whose worker died before
 * writing its half, would otherwise be accused of detaching a branch it never touched.
 */
function branchDuringRun(runDir) {
  const beforeFile = path.join(runDir, 'branch-before.txt');
  const afterFile = path.join(runDir, 'branch-after.txt');
  if (!fs.existsSync(beforeFile) || !fs.existsSync(afterFile)) return null;
  const before = readText(beforeFile).trim();
  const after = readText(afterFile).trim();
  if (before === after) return null;
  if (before && !after) return `branch moved despite prohibition: ${before} → detached HEAD`;
  return `branch moved despite prohibition: ${before || 'detached HEAD'} → ${after}`;
}

/**
 * Status comes from artifacts, never from intent. An abandoned run leaves raw.log at
 * zero bytes, and that is a FAIL with its own reason — not a retry hint. An empty
 * result with a quota signal in the log is LIMIT; without one it is FAIL.
 */
export function resolveStatus({ log, logBytes, resultOk, exit, agent, result, runDir }) {
  if (!logBytes) {
    return {
      status: 'FAIL',
      reason: 'run abandoned at startup: raw.log is empty, Codex did not run',
    };
  }
  // Ahead of everything else, including LIMIT: a commit under an explicit ban is a broken
  // contract, not a grade for the work. Whatever else the run produced, the orchestrator has
  // to learn first that history moved under it.
  if (agent === 'codex-build') {
    const committed = commitDuringRun(runDir);
    if (committed) return { status: 'FAIL', reason: committed };
    const branched = branchDuringRun(runDir);
    if (branched) return { status: 'FAIL', reason: branched };
  }
  if (!resultOk) {
    const limit = limitSignal(log);
    if (limit) return { status: 'LIMIT', reason: limit };
    return { status: 'FAIL', reason: reasonFrom(log) || `result is empty, exit=${exit}` };
  }
  if (exit !== 0) {
    return { status: 'FAIL', reason: `result exists, but exit=${exit}: ${reasonFrom(log)}` };
  }
  // A red verification is a failed job, not an OK with a footnote. The orchestrator
  // reads the first word; burying "fail" in line three is how a broken build passes.
  if (agent === 'codex-build' && result?.verify_passed === false) {
    return {
      status: 'FAIL',
      reason: `verification “${line(result.verify_command || 'no command', 60)}” failed; changes remain in the tree`,
    };
  }
  // Answers that never arrived, or arrived as coordinates. Scout-only, and per-question
  // only when the order asked several questions — see scoutCoverageGap().
  if (agent === 'codex-scout') {
    const gap = scoutCoverageGap(runDir, result);
    if (gap) return { status: 'FAIL', reason: gap };
  }
  // Files the task never authorised. Checked before the mismatch below, because a run that
  // did the job AND edited three unrelated files passes reportVersusWork() — one matching
  // path is all it needs — and the unrelated files would go unmentioned. No automatic
  // revert: what to do with the extra edits is the orchestrator's call, not this file's.
  if (agent === 'codex-build') {
    const patterns = readText(path.join(runDir, 'scope.txt'))
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (patterns.length) {
      // Environment writes are subtracted first: attributing them to the run failed an honest
      // pass for a file it never opened. What was subtracted is reported, not swallowed —
      // see the "Environment" line in reply.mjs and environment_changes in meta.json.
      const { work } = splitRunChanges(
        runDir,
        changedPaths(
          readText(path.join(runDir, 'state-before.txt')),
          readText(path.join(runDir, 'state-after.txt')),
        ),
      );
      const strays = outOfScope(work, patterns);
      if (strays.length) {
        return {
          status: 'FAIL',
          reason: `out-of-scope changes (${strays.length}): ${strays.slice(0, 3).join(', ')}`,
        };
      }
    }
  }
  // Work on the wrong thing is a failed job even when every artifact is well-formed. The
  // run that forced this check was green on all of them while Codex spent the quota
  // quarantining someone else's session file.
  if (agent === 'codex-build') {
    const verdict = reportVersusWork(runDir, result, chainContextOf(runDir));
    if (!verdict.ok) {
      // Hooks on is the known cause of this exact failure, so the reason says so instead
      // of leaving the operator to rediscover it from the log.
      const hooks = readJson(path.join(runDir, 'env.json'))?.hooks
        ? ' (hooks are enabled in run-config.json — a likely cause)'
        : '';
      return { status: 'FAIL', reason: `${verdict.reason}${hooks}` };
    }
    // Work found in the chain but not in this run's delta is done work, not a lie: the
    // second pass of a task legitimately has little left to change.
    if (verdict.carried) return { status: 'OK', reason: null, carried: true };
  }
  return { status: 'OK', reason: null };
}
