/**
 * Renders the reply lines a dispatcher is allowed to return, one format per agent.
 *
 * AGENTS is the registry of the three dispatchers: for each one it names the result file
 * that run writes, how to tell that file is filled in, and which of the three reply
 * strategies below renders it. FAIL and LIMIT bypass the per-agent strategy — a run that
 * produced nothing has nothing agent-specific left to say.
 *
 * The lines built here ARE the reply. Agents forward this text verbatim instead of
 * composing prose, which is what keeps a delegated run at five lines.
 */
import fs from 'node:fs';
import path from 'node:path';
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
    result: 'result.json',
    filled: (r) => Boolean(String(r?.answer || '').trim()),
    reply: scoutReply,
  },
  'codex-build': {
    result: 'result.json',
    filled: (r) => Boolean(String(r?.summary || '').trim()),
    reply: buildReply,
  },
  'codex-review': {
    result: 'review.json',
    filled: (r) => Boolean(String(r?.verdict || '').trim()),
    reply: reviewReply,
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
    `OK — ${line(r.summary, 160)}`,
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
