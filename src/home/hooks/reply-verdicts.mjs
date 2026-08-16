/** Provides the reply guard's operator-facing verdict text. */
import path from 'node:path';

export const fact = (value) => (value === undefined || value === null || value === '' ? 'not recorded' : String(value));

/**
 * The text the operator reads when the state budget is gone. Everything in it is quoted
 * from status.json — the operator is being told to stop, and a stop justified by guesswork
 * is a stop he learns to ignore. `fact` names the missing field instead of inventing one.
 */
export const stopText = (headline, observed, runStatus, folder) => {
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

export const missingHostOrderIdReason =
  'Contract violated: the host-refusal reply is missing the order id the orchestrator issued.';

export const nonexistentRunReason =
  'Contract violated: the response has no RUN= or ATTACH= line with an existing run folder, so ' +
  'delegation to Codex is not confirmed. Run codex-bridge run and return its stdout ' +
  'verbatim — the ATTACH=<path> line and the status block below it. If no run occurred, ' +
  'report the runner status: your own analysis instead of Codex is prohibited in all outcomes.';

export const missingRunReason =
  'Contract violated: the response has no RUN= or ATTACH= line, so delegation to Codex is not ' +
  'confirmed. Run codex-bridge run and return its stdout verbatim. If the runner refused before ' +
  'creating a folder, return that refusal exactly as printed.';

export const noRecentRunReason =
  'Contract violated: the response has no RUN= or ATTACH= line, and no recent run for this ' +
  'dispatcher was found on disk. Run codex-bridge run and return its stdout verbatim; your own ' +
  'analysis instead of Codex is prohibited in all outcomes.';

export const noRecentRunStop = (maxBlocks, agentType, runsDir) => stopText(
  `The reply guard stopped the session: the dispatcher responded ${maxBlocks} times ` +
    'without naming a run and no recent matching run was found on disk.',
  `No run for agent ${agentType} was found in the last 24 hours.`,
  null,
  runsDir,
);

export const omittedSiblingReason = (runDir, dir, status) =>
  `Contract violated: the response names ${runDir} but omits live run folder ${dir}; report every ` +
  `live run with its agent ${status.agent}, slug ${status.slug}, and repository ${status.repo}.`;

export const omittedSiblingStop = (maxBlocks, dir, status) => stopText(
  `The reply guard stopped the session: the dispatcher responded ${maxBlocks} times ` +
    'while a live sibling Codex run was omitted from its reply.',
  `status.json in ${dir} says state=running; process pid ${fact(status.pid)} is alive.`,
  status,
  dir,
);

export const orderMismatchStop = (maxBlocks, mismatch, runStatus, runDir) => stopText(
  `The reply guard stopped the session: the dispatcher returned another order's run ${maxBlocks} times.`,
  mismatch.observed,
  runStatus,
  runDir,
);

export const liveRunReason =
  'Contract violated: status.json says state=running and the process is alive — the run is ' +
  'not finished, but you are already responding. The STARTED output of the starting call ' +
  'is not a result. Repeat the identical codex-bridge run command, same --order-id, with ' +
  'timeout 1800000: it attaches to this same run, costs no quota, and prints the verdict.';

export const liveRunStop = (maxBlocks, runStatus, runDir) => stopText(
  `The reply guard stopped the session: the dispatcher responded ${maxBlocks} ` +
    'times while the Codex run was still in progress.',
  `status.json currently says state=running; process pid ${fact(runStatus.pid)} is alive.`,
  runStatus,
  runDir,
);

export const deadRunReason =
  'Contract violated: status.json says state=running, but the process with this pid is dead ' +
  'and meta.json is missing — the run is abandoned. Repeat the identical codex-bridge run ' +
  'command, same --order-id, with timeout of at least 1800000 and return its stdout verbatim.';

export const deadRunStop = (maxBlocks, runStatus, runDir) => stopText(
  `The reply guard stopped the session: the dispatcher responded ${maxBlocks} times for a run it did not complete.`,
  `status.json currently says state=running, but process pid ${fact(runStatus.pid)} is ` +
    'dead and meta.json is missing: an interrupted Bash call killed the runner. Codex ' +
    'survives the runner and keeps editing the tree — in run 2026-07-31_114736, changes ' +
    'in 11+ files survived while no run artifact and no meta.json were ever recorded.',
  runStatus,
  runDir,
);

export const abandonedRunReason =
  'Contract violated: status.json says state=abandoned — the runner died without a verdict. ' +
  'Repeat the identical codex-bridge run command, same --order-id, with timeout of at least ' +
  '1800000 and return its stdout verbatim.';

export const abandonedRunStop = (maxBlocks, runStatus, runDir) => stopText(
  `The reply guard stopped the session: the dispatcher responded ${maxBlocks} times for an abandoned run.`,
  `status.json currently says state=abandoned (${fact(runStatus.abandoned_reason)}, ` +
    `${fact(runStatus.abandoned_at)}): the runner died without recording a verdict. Codex ` +
    'survives the runner and keeps editing the tree — in run 2026-07-31_114736, changes in ' +
    '11+ files survived while no run artifact and no meta.json were ever recorded.',
  runStatus,
  runDir,
);

export const missingMetaReason = (runDir) =>
  `Contract violated: run folder ${runDir} has no meta.json; nothing supports the ` +
  'response. Run codex-bridge run again and return its stdout verbatim.';

export const missingDiscoveredMetaStop = (maxBlocks, discoveredStatus, runDir) => stopText(
  `The reply guard stopped the session: the dispatcher responded ${maxBlocks} times ` +
    'without naming the recent run found on disk.',
  `status.json says state=${fact(discoveredStatus?.state)}, status=${fact(discoveredStatus?.status)}, ` +
    'but the adjacent meta.json is missing.',
  discoveredStatus,
  runDir,
);

export const statusMismatchReason = (claimed, meta, discoveredStatus, runDir) =>
  `Contract violated: you reported ${claimed}, but run folder ${runDir} has ` +
  `state=${fact(discoveredStatus?.state)} in status.json and status=${meta.status} in meta.json ` +
  `(${meta.reason || 'no reason given'}). The runner calculates status from artifacts — return ` +
  'its output verbatim without substituting your own judgment.';

export const statusMismatchStop = (maxBlocks, claimed, meta, discoveredStatus, runDir) => stopText(
  `The reply guard stopped the session: the dispatcher contradicted the recent run on disk ${maxBlocks} times.`,
  `status.json says state=${fact(discoveredStatus.state)}, status=${fact(discoveredStatus.status)}; ` +
    `meta.json says status=${meta.status}, but the reply says ${claimed}.`,
  discoveredStatus,
  runDir,
);

export const omittedDiscoveredRunReason = (meta, discoveredStatus, runDir) =>
  `Contract violated: the response omitted RUN=${runDir}; status.json says ` +
  `state=${fact(discoveredStatus.state)}, status=${fact(discoveredStatus.status)}, and meta.json ` +
  `says status=${fact(meta.status)}. Return the runner stdout verbatim.`;

export const omittedDiscoveredRunStop = (maxBlocks, meta, discoveredStatus, runDir) => stopText(
  `The reply guard stopped the session: the dispatcher omitted the recent run found on disk ${maxBlocks} times.`,
  `status.json says state=${fact(discoveredStatus.state)}, status=${fact(discoveredStatus.status)}; ` +
    `meta.json says status=${fact(meta.status)}.`,
  discoveredStatus,
  runDir,
);
