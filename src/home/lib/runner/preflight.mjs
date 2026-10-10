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
import { orderInputName } from '../order-schema.mjs';
import { retiredPathRefusal, runsRootResolution } from './runs-root.mjs';

/** Plan_60 D2: only conclusive evidence says UNAVAILABLE; a PATH miss is inconclusive (Plan_78 D5). */
export async function codexAvailabilityRefusal({ probe = probeCodexAvailability } = {}) {
  const result = await probe();
  if (result.state === 'available') return null;
  const unavailable = result.state === 'logged-out';
  const rows = unavailable ? unavailableRows(result.detail) : result.pathMiss === true ? [
    `Codex CLI readiness unconfirmed: ${result.detail}`,
    'Do not skip this bridge: check codex --version for up to about 2 minutes; when it answers, repeat the same order exactly once; if it does not answer, hand the order to the next executor and name that in the summary.',
  ] : [
    `Codex CLI unavailable: ${result.detail}`,
    'Operator check: codex --version (and codex login if authorization is rejected)',
  ];
  return {
    unavailable,
    text: [...rows, 'The run folder was not created; quota was not spent.'].join('\n'),
  };
}

/** Plan_59 D5/D6: settle design authority before any probe can spend quota. */
export function taskPreflight({ agent, taskText, header, resolution = runsRootResolution() }) {
  const freeRefusal = (reason) => ({
    refusal: `${reason}\nThe run folder was not created; quota was not spent.`,
  });
  if (agent === 'codex-advisor') {
    const reason = advisorTaskRefusal(taskText);
    return reason ? freeRefusal(reason) : { refusal: null };
  }
  if (agent !== 'codex-build') return { refusal: null };
  const advice = header.advice;
  if (advice !== null) {
    if (['mechanical', 'revert', 'docs-only', 'test-only'].includes(advice)) {
      return { refusal: null, advice };
    }
    if (path.isAbsolute(advice)) {
      // Plan_77 D6: preflight.mjs:46-58 swallowed the old-path read failure as missing advice.
      // Diagnose before stat/read so neither existing nor absent retired evidence is opened.
      const retired = retiredPathRefusal(advice, resolution);
      if (retired) return freeRefusal(retired);
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
  return freeRefusal('codex-build requires the task file to start with the header line `advice: <value>`, where the ' +
    'value is mechanical | revert | docs-only | test-only ' +
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
  // Plan_59 D7: phase 2 must retain the scope run's predictions before quota is spent.
  if (agent === 'codex-advisor' && phase === 'advise' && !isContinue) {
    die(`codex-advisor ${orderInputName('phase')} advise requires a ${orderInputName('continue')} grant naming the scope run: phase 2 continues the scope run of the same order ` +
      'so it can settle the risks phase 1 predicted. The run folder was not created; quota was not spent.');
  }
  const phases = budgets[agentRole(agent)];
  const names = Object.keys(phases);
  if (phase === undefined && names.length === 1 && names[0] === 'default') return 'default';
  if (phase !== undefined && Object.hasOwn(phases, phase)) return phase;
  die(`${phase === undefined ? `${orderInputName('phase')} is required` : `undeclared ${orderInputName('phase')} ${JSON.stringify(phase)}`} ` +
    `for ${agent}. Action: pass ${orderInputName('phase')} <name>; allowed phases: ${names.join(', ')}. ` +
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
