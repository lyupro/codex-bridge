/**
 * Moves the run records from the retired default root into the package home, on the operator's signal.
 *
 * Plan_77 D3/D7: projects are closed by the operator; refuse live runs and prove
 * the copy and import D4 history before writing the D7 move record that switches roots.
 * The 2026-10-07 VaultForge $16.57 journal incident is why records leave foreign git.
 */
import fs from 'node:fs';
import { runsRootResolution } from '../src/home/lib/runner/runs-root.mjs';
import { resolveBrandHome } from '../src/home/lib/brand-home.mjs';
import { writeRunsMoveRecord } from '../src/home/lib/runner/retired-roots.mjs';
import { allLiveRuns } from '../src/home/hooks/live-runs.mjs';
import { checkRunStoreDestination, copyRunStore, inspectRunStore } from './runs-move-copy.mjs';
import { importRunHistory, inspectRunHistory, runGit } from './runs-move-history.mjs';

export function runsMove({ dryRun = false, resolution = runsRootResolution(), liveRuns = allLiveRuns,
  stateDir, importHistory = importRunHistory, git = runGit } = {}) {
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
    if (dryRun) {
      const history = inspectRunHistory({ from: legacyRoot, git });
      const description = history.imported === false ? history.reason : `would import ${history.commits} commits`;
      return { exitCode: 0,
        output: `Would copy ${counts.files} files (${megabytes} MB) in ${counts.directories} folders from ${legacyRoot} to ${homeRoot}; history: ${description}. Dry run: nothing changed.` };
    }
    let history;
    try {
      history = importHistory({ from: legacyRoot, to: homeRoot, git });
    } catch (error) {
      // D4/D7: this initially empty/absent copy is ours; a failed import must never switch roots.
      fs.rmSync(homeRoot, { recursive: true, force: true });
      throw error;
    }
    // D7: publishing the record is the last write, after copy verification and D4 history import.
    writeRunsMoveRecord(stateDir ?? resolution.stateDir ?? resolveBrandHome().stateDir, { root: legacyRoot });
    const description = history.imported ? `imported ${history.commits} commits` : history.reason;
    return { exitCode: 0,
      output: `Moved ${counts.files} files (${megabytes} MB) from ${legacyRoot} to ${homeRoot}; history: ${description}. New runs write to ${homeRoot}. The old folder is untouched.` };
  } catch (error) {
    return refuse(`${error.message}\nNothing was switched; the old folder is untouched.`);
  }
}
