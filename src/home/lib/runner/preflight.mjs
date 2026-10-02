/**
 * Refusals that must not touch the tree, decided before a run is registered. On 2026-09-19,
 * a busy-tree refusal left its own folder in the live writer's witness. This boundary knows
 * only the project runs root and existing holders, never the prospective run's directory.
 */
import path from 'node:path';
import fs from 'node:fs';
import { advisorTaskRefusal } from '../meta/advisor-task.mjs';
import { unavailableRows } from '../meta/reply.mjs';
import { activeRunDetails, readJson } from '../write-meta.mjs';
import { probeCodexAvailability } from './codex-availability.mjs';
import { agentRole } from '../agents.mjs';
import { die } from './args.mjs';

/** Plan_60 D2: only conclusive evidence says UNAVAILABLE; an unclear probe stays an ordinary refusal. */
export async function codexAvailabilityRefusal({ probe = probeCodexAvailability } = {}) {
  const result = await probe();
  if (result.state === 'available') return null;
  const unavailable = result.state === 'missing' || result.state === 'logged-out';
  const rows = unavailable ? unavailableRows(result.detail) : [
    `Codex CLI unavailable: ${result.detail}`,
    'Operator check: codex --version (and codex login if authorization is rejected)',
  ];
  return {
    unavailable,
    text: [...rows, 'The run folder was not created; quota was not spent.'].join('\n'),
  };
}

/** Plan_59 D5/D6: settle design authority before any probe can spend quota. */
export function taskPreflight({ agent, taskText }) {
  const freeRefusal = (reason) => ({
    refusal: `${reason}\nThe run folder was not created; quota was not spent.`,
  });
  if (agent === 'codex-advisor') {
    const reason = advisorTaskRefusal(taskText);
    return reason ? freeRefusal(reason) : { refusal: null };
  }
  if (agent !== 'codex-build') return { refusal: null };
  const lines = taskText.split(/\r\n|\n|\r/)
    .flatMap((line) => {
      const match = line.match(/^\s*(?:-\s+)?advice\s*:\s*(.*?)\s*$/i);
      return match ? [match[1]] : [];
    });
  const advice = lines[0];
  if (lines.length === 1) {
    if (['mechanical', 'revert', 'docs-only', 'test-only'].includes(advice)) {
      return { refusal: null, advice };
    }
    if (path.isAbsolute(advice)) {
      try {
        // Plan_59 D26: only a judged advice authorizes a construction. On 2026-09-24 the gate took
        // any codex-advisor folder, so a scope run or a FAIL advice would have passed as a second opinion.
        const meta = fs.statSync(advice).isDirectory() ? readJson(path.join(advice, 'meta.json')) : null;
        if (meta?.agent === 'codex-advisor' && meta.phase === 'advise' && meta.status === 'OK') {
          return { refusal: null, advice };
        }
      } catch {
        // Plan_59 D6: missing or unreadable evidence cannot authorize a construction.
      }
    }
  }
  return freeRefusal('codex-build requires exactly one advice: line: mechanical | revert | docs-only | test-only ' +
    'or an absolute path to an existing advisor run directory whose meta.json says agent codex-advisor, ' +
    'phase advise, status OK. ' +
    'An order that invents a construction needs a second opinion first; only work with no design choice may skip it.');
}

/** Plan_59 D14: an advice pass may continue only a completed, successful advisor scope run. */
export function scopeRunRefusal({ agent, phase, runsRoot, grantRun }) {
  if (agent !== 'codex-advisor' || phase !== 'advise') return null;
  let meta;
  try {
    meta = readJson(path.join(runsRoot, grantRun, 'meta.json'));
  } catch {
    meta = null;
  }
  const failed = [
    meta?.agent === 'codex-advisor' ? null : "agent must be 'codex-advisor'",
    meta?.phase === 'scope' ? null : "phase must be 'scope'",
    meta?.status === 'OK' ? null : "status must be 'OK'",
  ].filter(Boolean);
  if (!failed.length) return null;
  return `continued run meta.json failed ${failed.join(', ')}. The run folder was not created; quota was not spent.`;
}

/** D2: phase mistakes must refuse before even the sandbox probe can spend quota. */
export function resolveRunPhase({ agent, phase, continue: isContinue }, budgets) {
  // OW-040, 2026-09-30: continuing a failed scope spent the order's only continuation and blocked advise.
  if (agent === 'codex-advisor' && phase === 'scope' && isContinue) {
    die('codex-advisor --phase scope refuses --continue: a scope pass is never continued, and continuing one ' +
      "spends the order's single continuation that its advise phase needs. Action: repeat the scope under a new order id " +
      "without --continue and without a continue: grant, then run advise as that order's continuation. The run folder " +
      'was not created; quota was not spent.');
  }
  // Plan_59 D7: phase 2 must retain the scope run's predictions before quota is spent.
  if (agent === 'codex-advisor' && phase === 'advise' && !isContinue) {
    die('codex-advisor --phase advise requires --continue: phase 2 continues the scope run of the same order ' +
      'so it can settle the risks phase 1 predicted. The run folder was not created; quota was not spent.');
  }
  const phases = budgets[agentRole(agent)];
  const names = Object.keys(phases);
  if (phase === undefined && names.length === 1 && names[0] === 'default') return 'default';
  if (phase !== undefined && Object.hasOwn(phases, phase)) return phase;
  die(`${phase === undefined ? '--phase is required' : `undeclared --phase ${JSON.stringify(phase)}`} ` +
    `for ${agent}. Action: pass --phase <name>; allowed phases: ${names.join(', ')}. ` +
    'The run folder was not created; quota was not spent.');
}

export function preflightRefusal({ agent, projectRunsRoot, repoRoot }) {
  // Two writing runs share one tree: the second snapshot would include the first one's edits.
  const busy = agent === 'codex-build' ? activeRunDetails(projectRunsRoot, repoRoot) : null;
  if (busy) {
    const identityNote = busy.identity === 'unverified'
      ? '; process identity could not be confirmed'
      : '';
    return [
      `run ${busy.run} is already active for this repository; two writing runs in one tree are prohibited${identityNote}`,
      `Active run: ${path.join(projectRunsRoot, busy.run)}`,
      // One sentence, the same one every other pre-flight refusal ends with. The older wording
      // said the identical thing twice, which is how two copies of a rule start to drift.
      'The run folder was not created; quota was not spent.',
    ].join('\n');
  }

  return null;
}
