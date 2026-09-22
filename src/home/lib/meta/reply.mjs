/**
 * Renders the reply lines a dispatcher is allowed to return, one format per agent.
 *
 * AGENTS adds reply strategies to the shared agent registry: for each one it describes how
 * to tell the result file is filled in and which reply strategy below renders it. FAIL and LIMIT bypass the per-agent strategy — a run that
 * produced nothing has nothing agent-specific left to say.
 *
 * The lines built here ARE the reply. Agents forward this text verbatim instead of
 * composing prose, which is what keeps a delegated run at five lines.
 */
import fs from 'node:fs';
import path from 'node:path';
import { AGENTS as AGENT_DEFINITIONS } from '../agents.mjs';
import { changedPaths, line, readText } from './paths.mjs';
import { splitRunChanges } from './environment.mjs';
import { scoutCoverage } from './verdict.mjs';

/** What the run itself changed, and what the tooling around it changed while it worked. */
const runChanges = (runDir) =>
  splitRunChanges(
    runDir,
    changedPaths(readText(path.join(runDir, 'state-before.txt')), readText(path.join(runDir, 'state-after.txt'))),
  );

const readCommand = (runDir) => `codex-bridge read ${runDir}`;

export const AGENTS = {
  'codex-scout': {
    ...AGENT_DEFINITIONS['codex-scout'],
    filled: (r) => Boolean(String(r?.answer || '').trim()),
    reply: scoutReply,
  },
  'codex-build': {
    ...AGENT_DEFINITIONS['codex-build'],
    filled: (r) => Boolean(String(r?.summary || '').trim()),
    reply: buildReply,
  },
  'codex-review': {
    ...AGENT_DEFINITIONS['codex-review'],
    filled: (r) => Boolean(String(r?.verdict || '').trim()),
    reply: reviewReply,
  },
  // Plan_59 D4: one result file, two contracts. Either phase's decisive field proves it is filled.
  'codex-advisor': {
    ...AGENT_DEFINITIONS['codex-advisor'],
    filled: (r) => typeof r?.sufficient === 'boolean' || Boolean(String(r?.recommendation?.option_id || '').trim()),
    reply: advisorReply,
  },
};

function scoutReply(ctx) {
  const r = ctx.result;
  const top = (r.findings || [])[0];
  const unknowns = (r.unknowns || []).filter(Boolean);
  const coverage = scoutCoverage(ctx.runDir, r);
  return [
    `OK — ${line(r.answer, 160)}`,
    // Any explicit question gets a coverage line, including a valid one-question order.
    ...(coverage ? [`Coverage: ${coverage}`] : []),
    `Key finding: ${top ? `${line(top.fact, 130)} (${line(top.where, 60)})` : 'no findings listed'}`,
    `Unresolved: ${unknowns.length ? line(unknowns.join('; '), 160) : 'none'}`,
    `Report: ${ctx.file('report.md')} · Log: ${readCommand(ctx.runDir)}`,
  ];
}

function buildReply(ctx) {
  const r = ctx.result;
  const { work: touchedPaths, environment } = runChanges(ctx.runDir);
  const paths = touchedPaths.slice(0, 3).join(', ');
  const flags = readText(path.join(ctx.runDir, 'flags.txt')).split(/\r?\n/).filter(Boolean);
  // A multi-line verification is several commands, and collapsing them into one 60-character
  // line cut the last one mid-word: the reply named a command nobody could run.
  const commands = String(r.verify_command ?? '')
    .split(/\r?\n/)
    .map((command) => command.trim())
    .filter(Boolean);
  const verify = commands.length
    ? `${line(commands[0], 60)}${commands.length > 1 ? ` (+${commands.length - 1} more)` : ''}`
    : 'not run';
  const verdict = r.verify_command
    ? r.verify_passed === true
      ? 'pass'
      : r.verify_passed === false
        ? 'fail'
        : 'result not reported'
    : 'n/a';
  // A pass that changed nothing because the previous pass of the same task already did the
  // work says so on the files line: "0 changed" alone reads as a run that achieved nothing.
  const files = ctx.carried
    ? `${paths ? `${paths} · ` : ''}changes were made by an earlier run of this task`
    : paths || 'worktree untouched';
  return [
    `OK — ${line(r.summary, 300)}`,
    `Files: ${touchedPaths.length} changed · ${files}`,
    // Only when something outside the run wrote to the tree. Subtracting those paths from the
    // verdict without naming them would hide a real edit behind a pattern.
    ...(environment.length
      ? [`Environment: ${environment.length} changed outside the run — ${line(environment.slice(0, 3).join(', '), 120)}`]
      : []),
    `Verification: ${verify} — ${verdict}`,
    `Flags: ${flags.length ? `${flags.length} TODO/skip — ${line(flags.slice(0, 3).join(' | '), 140)}` : 'none'}`,
    `Report: ${ctx.file('report.md')} · Log: ${readCommand(ctx.runDir)}`,
  ];
}

function reviewReply(ctx) {
  const r = ctx.result;
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  (r.findings || []).forEach((f) => {
    if (counts[f.severity] !== undefined) counts[f.severity] += 1;
  });
  const top = (r.findings || []).find((f) => f.severity === 'critical' || f.severity === 'high');
  return [
    `OK — verdict ${line(r.verdict, 40)}`,
    `Findings: critical ${counts.critical} · high ${counts.high} · medium ${counts.medium} · low ${counts.low}`,
    `Top: ${top ? `${top.severity} ${line(top.file, 80)}:${top.line_start} — ${line(top.title, 90)}` : 'no critical or high findings'}`,
    `Report: ${ctx.file(path.basename(ctx.resultPath))} · Log: ${readCommand(ctx.runDir)}`,
  ];
}

/**
 * Plan_59 D4: an insufficient scope is an OK run with a named outcome, not a LIMIT — the first
 * word stays the status, and the outcome that decides the orchestrator's next step is the first
 * thing after it, derived from the same fields meta.json records.
 */
function advisorReply(ctx) {
  const r = ctx.result;
  const log = `Report: ${ctx.file(path.basename(ctx.resultPath))} · Log: ${readCommand(ctx.runDir)}`;
  // The result's own shape picks the lines, as it does in `filled`: a run folder missing its phase
  // record must not send a scope answer into the advise branch and crash the verdict.
  if (typeof r.sufficient === 'boolean') {
    const missing = r.missing_paths || [];
    const risks = r.predicted_risks || [];
    return [
      r.sufficient
        ? 'OK — scope: sufficient; continue this run with --phase advise'
        : `OK — scope: insufficient; ${missing.length} paths named`,
      ...(missing.length ? [`Missing: ${line(missing.join(', '), 160)}`] : []),
      `Predicted risks: ${risks.length}${risks[0] ? ` — ${risks[0].id} ${line(risks[0].risk, 120)}` : ''}`,
      log,
    ];
  }
  const outcomes = r.risk_outcomes || [];
  const confirmed = outcomes.filter((o) => o.outcome === 'confirmed').length;
  const rejected = (r.rejected || []).map((o) => `${o.option_id} (${line(o.cost, 60)})`);
  return [
    `OK — recommend ${r.recommendation.option_id}: ${line(r.recommendation.text, 200)}`,
    `Rejected: ${rejected.length ? line(rejected.join('; '), 180) : 'none'}`,
    `Counter: ${line(r.strongest_counterargument, 180)}`,
    `Risks: ${confirmed} confirmed · ${outcomes.length - confirmed} refuted · open questions ${(r.open_questions || []).length} · confidence ${r.confidence}`,
    log,
  ];
}

/**
 * Which worker actually ran, printed next to the log link.
 *
 * A dispatcher reads these rows and nothing else, so a run on the wrong model was invisible here
 * for three releases: the configured profile never reached the command line, and no reply said
 * which model had answered (2026-08-26). The row names the depth's origin too — a `fallback`
 * depth on a mode configured for `max` is the same silence one level down.
 */
export function profileRow(meta) {
  const profile = meta?.profile;
  if (!profile?.effort) return null;
  const model = profile.model || 'codex default';
  return `Model: ${model} at ${profile.effort} effort (${profile.effort_source})`;
}

/**
 * Inserted before the row carrying the log link, or appended when a reply has none. The link is
 * matched anywhere in the row, not at its start: scout and review put it after the report path,
 * and the profile belongs beside it in every reply rather than only in two of them.
 */
export function withProfileRow(rows, meta) {
  const row = profileRow(meta);
  if (!row) return rows;
  const at = rows.findIndex((r) => r.includes('Log: '));
  return at === -1 ? [...rows, row] : [...rows.slice(0, at), row, ...rows.slice(at)];
}

export function failReply(ctx, meta) {
  return [
    `FAIL — ${line(meta.reason, 170)}`,
    `Artifacts: events.jsonl ${meta.events_bytes} B · stderr.log ${meta.stderr_bytes} B · ${path.basename(ctx.resultPath)} ${meta.result_ok ? 'filled' : 'empty or missing'} · exit=${meta.exit}`,
    // A failed build says what it left behind, exactly as a LIMIT does. "The work was not
    // done" is not "the tree is clean": a run can write half a change and then declare fail,
    // and the orchestrator has to know whether there is something to revert before it decides
    // anything else.
    ...(ctx.agent === 'codex-build' ? [`Worktree: ${worktreeState(ctx.runDir)}`] : []),
    `Log: ${readCommand(ctx.runDir)}`,
  ];
}

/**
 * What the run left in the tree, or an admission that nobody knows. Both snapshots are
 * required: a run killed before it wrote state-after.txt has no delta to compute, and
 * printing "no new changes" there would be a claim made out of missing data — the same
 * mistake status.json's `tree_after: false` exists to prevent.
 */
function worktreeState(runDir) {
  const hasSnapshots = ['state-before.txt', 'state-after.txt'].every((f) =>
    fs.existsSync(path.join(runDir, f)),
  );
  if (!hasSnapshots) return 'unknown — the run left no worktree snapshot, check git status';
  const { work } = runChanges(runDir);
  return work.length
    ? `has unfinished changes (${work.length}): ${line(work.slice(0, 3).join(', '), 120)}`
    : 'no new changes';
}

export function limitReply(ctx, meta) {
  const rows = [
    'LIMIT — ChatGPT quota exhausted, work not completed',
    `Signal: ${line(meta.reason, 170)}`,
  ];
  if (ctx.agent === 'codex-build') {
    const { work: touched } = runChanges(ctx.runDir);
    rows.push(
      `Worktree: ${touched.length ? `has unfinished changes (${touched.length}), see git-after.txt` : 'no new changes'}`,
    );
  }
  rows.push(`Log: ${readCommand(ctx.runDir)}`);
  return rows;
}
