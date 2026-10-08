/**
 * Moves the run records from the retired default root into the package home, on the operator's signal.
 *
 * Plan_77 D3/D7: projects are closed by the operator; refuse live runs and prove
 * the copy before any later order switches roots. B5a never writes a move record.
 * The 2026-10-07 VaultForge $16.57 journal incident is why records leave foreign git.
 */
import { runsRootResolution } from '../src/home/lib/runner/runs-root.mjs';
import { allLiveRuns } from '../src/home/hooks/live-runs.mjs';
import { checkRunStoreDestination, copyRunStore, inspectRunStore } from './runs-move-copy.mjs';

export function runsMove({ dryRun = false, resolution = runsRootResolution(), liveRuns = allLiveRuns } = {}) {
  const { source, root, legacyRoot, homeRoot } = resolution;
  const refuse = (output) => ({ exitCode: 1, output });
  if (source === 'CODEX_RUNS_ROOT') {
    return refuse(`CODEX_RUNS_ROOT is set to ${root}; unset it to move the default run store.`);
  }
  if (source === 'moved') return refuse(`Run records already live in ${homeRoot}.`);
  if (source === 'default') return refuse(`No run store to move: ${legacyRoot} does not exist.`);
  try {
    const live = liveRuns(legacyRoot);
    if (live.length) {
      return refuse(`Runs are still live in ${legacyRoot}:\n${live.map(({ dir }) => dir).join('\n')}. `
        + 'Wait for them or stop them with codex-bridge stop, then repeat.');
    }
    checkRunStoreDestination({ from: legacyRoot, to: homeRoot });
  } catch (error) {
    return refuse(error.message);
  }
  try {
    const counts = dryRun ? inspectRunStore(legacyRoot) : copyRunStore({ from: legacyRoot, to: homeRoot });
    const megabytes = (counts.bytes / (1024 * 1024)).toFixed(2);
    return { exitCode: 0, output: dryRun
      ? `Would copy ${counts.files} files (${megabytes} MB) in ${counts.directories} folders from ${legacyRoot} to ${homeRoot}. Dry run: nothing changed.`
      : `Copied and verified ${counts.files} files (${megabytes} MB) from ${legacyRoot} to ${homeRoot}. The old folder is untouched; runs still write there until the move is completed.` };
  } catch (error) {
    return refuse(`${error.message}\nNothing was switched; the old folder is untouched.`);
  }
}
