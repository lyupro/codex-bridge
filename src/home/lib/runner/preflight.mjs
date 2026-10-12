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
import { orderRuleMessage } from '../order-rules.mjs';
import { orderDiagnosticMessage } from '../order-diagnostics.mjs';

/** Plan_60 D2: only conclusive evidence says UNAVAILABLE; a PATH miss is inconclusive (Plan_78 D5). */
export async function codexAvailabilityRefusal({ probe = probeCodexAvailability } = {}) {
  const result = await probe();
  if (result.state === 'available') return null;
  const unavailable = result.state === 'logged-out';
  const rows = unavailable ? unavailableRows(result.detail) : [orderDiagnosticMessage(
    result.pathMiss === true ? 'codex-readiness-unconfirmed' : 'codex-unavailable', { detail: result.detail },
  )];
  return {
    unavailable,
    text: [...rows, orderDiagnosticMessage('run-not-created')].join('\n'),
  };
}

/** Plan_59 D5/D6: settle design authority before any probe can spend quota. */
export function taskPreflight({ agent, taskText, header, resolution = runsRootResolution() }) {
  const freeRefusal = (reason) => ({
    refusal: [reason, orderDiagnosticMessage('run-not-created')].join('\n'),
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
  return freeRefusal(orderRuleMessage('build-advice-required'));
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
    meta?.agent === 'codex-advisor' ? null : orderRuleMessage('advise-scope-run-required', { violation: 'agent' }),
    meta?.phase === 'scope' ? null : orderRuleMessage('advise-scope-run-required', { violation: 'phase' }),
    meta?.status === 'OK' ? null : orderRuleMessage('advise-scope-run-required', { violation: 'status' }),
  ].filter(Boolean);
  if (!failed.length) return null;
  return [orderRuleMessage('advise-scope-run-required', {
    violation: 'meta', failed: failed.join(', '),
  }), orderDiagnosticMessage('run-not-created')].join(' ');
}

/** D2: phase mistakes must refuse before even the sandbox probe can spend quota. */
export function resolveRunPhase({ agent, phase, continue: isContinue }, budgets) {
  // Plan_59 D7: phase 2 must retain the scope run's predictions before quota is spent.
  if (agent === 'codex-advisor' && phase === 'advise' && !isContinue) {
    die([orderRuleMessage('advisor-advise-continuation', {
      phaseLabel: orderInputName('phase'), continueLabel: orderInputName('continue'),
    }), orderDiagnosticMessage('run-not-created')].join(' '));
  }
  const phases = budgets[agentRole(agent)];
  const names = Object.keys(phases);
  if (phase === undefined && names.length === 1 && names[0] === 'default') return names[0];
  if (phase !== undefined && Object.hasOwn(phases, phase)) return phase;
  die([orderRuleMessage('run-phase-required', {
    violation: phase === undefined ? 'missing' : 'undeclared', phaseLabel: orderInputName('phase'), phase, agent, names,
  }), orderDiagnosticMessage('run-not-created')].join(' '));
}

export function preflightRefusal({ agent, projectRunsRoot, repoRoot }) {
  // Two writing runs share one tree: the second snapshot would include the first one's edits.
  const busy = agent === 'codex-build' ? activeRunDetails(projectRunsRoot, repoRoot) : null;
  if (busy) {
    return [orderRuleMessage('writing-run-exclusive', {
      run: busy.run, activePath: path.join(projectRunsRoot, busy.run), identity: busy.identity,
    }), orderDiagnosticMessage('run-not-created')].join('\n');
  }

  return null;
}
