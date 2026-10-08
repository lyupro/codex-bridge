/**
 * Moves the run records from the retired default root into the package home, on the operator's signal.
 *
 * Plan_77 D3/D7: projects are closed by the operator; refuse live runs and prove
 * the copy and import D4 history before writing the D7 move record that switches roots.
 * The 2026-10-07 VaultForge $16.57 journal incident is why records leave foreign git.
 */
import fs from 'node:fs';
import path from 'node:path';
import { runsRootResolution } from '../src/home/lib/runner/runs-root.mjs';
import { resolveBrandHome } from '../src/home/lib/brand-home.mjs';
import { writeRunsMoveRecord } from '../src/home/lib/runner/retired-roots.mjs';
import { allLiveRuns } from '../src/home/hooks/live-runs.mjs';
import { checkRunStoreDestination, copyRunStore, inspectRunStore } from './runs-move-copy.mjs';
import { importRunHistory, inspectRunHistory, runGit } from './runs-move-history.mjs';
import { oldStoreDifferences } from './runs-move-remove.mjs';

export function runsMove({ dryRun = false, resolution = runsRootResolution(), liveRuns = allLiveRuns,
  stateDir, importHistory = importRunHistory, git = runGit } = {}) {
  const { source, root, legacyRoot, homeRoot } = resolution;
  const refuse = (output) => ({ exitCode: 1, output, oldStore: null, homeRoot });
  if (source === 'CODEX_RUNS_ROOT') {
    return refuse(`CODEX_RUNS_ROOT is set to ${root}; unset it to move the default run store.`);
  }
  if (source === 'moved') {
    try {
      if (fs.existsSync(legacyRoot) && fs.lstatSync(legacyRoot).isDirectory()) {
        return { exitCode: 0, oldStore: dryRun ? null : legacyRoot, homeRoot,
          output: `Run records already live in ${homeRoot}; the old folder ${legacyRoot} still exists.` };
      }
    } catch (error) {
      return refuse(error.message);
    }
    return refuse(`Run records already live in ${homeRoot}.`);
  }
  if (source === 'default') return refuse(`No run store to move: ${legacyRoot} does not exist.`);
  let liveRefusal = null;
  try {
    const live = liveRuns(legacyRoot);
    if (live.length) {
      liveRefusal = `Runs are still live in ${legacyRoot}:\n${live.map(({ dir }) => dir).join('\n')}. `
        + 'Wait for them or stop them with codex-bridge stop, then repeat.';
      // Like purge --dry-run: a preview names the refusal and still shows the move, since some
      // project is nearly always running and the operator plans the move from these numbers.
      if (!dryRun) return refuse(liveRefusal);
    }
    checkRunStoreDestination({ from: legacyRoot, to: homeRoot });
  } catch (error) {
    return refuse(liveRefusal ? `${liveRefusal}\n${error.message}` : error.message);
  }
  const staging = `${homeRoot}.moving-${process.pid}-${Date.now()}`;
  let ownsStaging = false;
  let published = false;
  try {
    if (!dryRun) {
      fs.lstatSync(legacyRoot);
      fs.mkdirSync(path.dirname(homeRoot), { recursive: true });
      fs.mkdirSync(staging);
      ownsStaging = true;
    }
    const counts = dryRun ? inspectRunStore(legacyRoot) : copyRunStore({ from: legacyRoot, to: staging });
    const megabytes = (counts.bytes / (1024 * 1024)).toFixed(2);
    if (dryRun) {
      const history = inspectRunHistory({ from: legacyRoot, git });
      const description = history.imported === false ? history.reason : `would import ${history.commits} commits`;
      const preview = `Would copy ${counts.files} files (${megabytes} MB) in ${counts.directories} folders from ${legacyRoot} to ${homeRoot}; history: ${description}. Dry run: nothing changed.`;
      return { exitCode: liveRefusal ? 1 : 0, oldStore: null, homeRoot,
        output: liveRefusal ? `${liveRefusal}\n${preview}` : preview };
    }
    const history = importHistory({ from: legacyRoot, to: staging, git });
    // Plan_77 F1: a writer may start or change records during copy/history import.
    const live = liveRuns(legacyRoot);
    const differences = oldStoreDifferences({ from: legacyRoot, to: staging });
    if (live.length || differences.count) {
      fs.rmSync(staging, { recursive: true, force: true });
      ownsStaging = false;
      return refuse(`A run started or a record changed during the move: ${[
        ...live.map(({ dir }) => dir), ...differences.paths,
      ].slice(0, 20).join(', ')}. Nothing was switched; repeat when no project is running.`);
    }
    // Plan_77 F1: publish only our exclusive staging folder; never roll back a competing store.
    if (checkRunStoreDestination({ from: legacyRoot, to: homeRoot })) fs.rmdirSync(homeRoot);
    fs.renameSync(staging, homeRoot);
    ownsStaging = false;
    published = true;
    const description = history.imported ? `imported ${history.commits} commits` : history.reason;
    // D7: publishing the record is the last write, after copy verification and D4 history import.
    writeRunsMoveRecord(stateDir ?? resolution.stateDir ?? resolveBrandHome().stateDir, { root: legacyRoot });
    return { exitCode: 0, oldStore: legacyRoot, homeRoot,
      output: `Moved ${counts.files} files (${megabytes} MB) from ${legacyRoot} to ${homeRoot}; history: ${description}. New runs write to ${homeRoot}. The old folder is untouched.` };
  } catch (error) {
    if (ownsStaging) fs.rmSync(staging, { recursive: true, force: true });
    if (published) fs.rmSync(homeRoot, { recursive: true, force: true });
    return refuse(`${error.message}\nNothing was switched; the old folder is untouched.`);
  }
}
