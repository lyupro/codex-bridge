/**
 * Refusals that must not touch the tree, decided before a run is registered. On 2026-09-19,
 * a busy-tree refusal left its own folder in the live writer's witness. This boundary knows
 * only the project runs root and existing holders, never the prospective run's directory.
 */
import path from 'node:path';
import { activeRunDetails } from '../write-meta.mjs';
import { codexUnavailableReason } from './codex-cmd.mjs';

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
