/**
 * Refusals that must not touch the tree, decided before a run is registered. On 2026-09-19,
 * a busy-tree refusal left its own folder in the live writer's witness. This boundary knows
 * only the project runs root and existing holders, never the prospective run's directory.
 */
import path from 'node:path';
import fs from 'node:fs';
import { advisorTaskRefusal } from '../meta/advisor-task.mjs';
import { activeRunDetails, readJson } from '../write-meta.mjs';
import { codexUnavailableReason } from './codex-cmd.mjs';
import { agentRole } from '../agents.mjs';
import { die } from './args.mjs';

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
        if (fs.statSync(advice).isDirectory() &&
            readJson(path.join(advice, 'meta.json'))?.agent === 'codex-advisor') {
          return { refusal: null, advice };
        }
      } catch {
        // Plan_59 D6: missing or unreadable evidence cannot authorize a construction.
      }
    }
  }
  return freeRefusal('codex-build requires exactly one advice: line: mechanical | revert | docs-only | test-only ' +
    'or an absolute path to an existing advisor run directory with meta.json agent codex-advisor. ' +
    'An order that invents a construction needs a second opinion first; only work with no design choice may skip it.');
}

/** D2: phase mistakes must refuse before even the sandbox probe can spend quota. */
export function resolveRunPhase({ agent, phase }, budgets) {
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

  const why = codexUnavailableReason();
  if (why !== null) {
    return [
      `Codex CLI unavailable: ${why}`,
      'Operator check: codex --version (and codex login if authorization is rejected)',
      'The run folder was not created; quota was not spent.',
    ].join('\n');
  }
  return null;
}
