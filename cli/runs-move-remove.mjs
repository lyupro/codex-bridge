/**
 * Removes the old run store once the operator agrees and every file in it has an identical copy in the new one.
 *
 * Plan_77 D3/B5c: an older package can still write to the old root after the D7 switch.
 */
import fs from 'node:fs';
import path from 'node:path';
import { inspectRunStore, sha256File } from './runs-move-copy.mjs';
import { askYesNo, isInteractive } from './terminal-question.mjs';

/** Returns the first 20 differing relative paths and the total count, including empty folders. */
export function oldStoreDifferences({ from, to, hash = sha256File }) {
  const source = path.resolve(from);
  const destination = path.resolve(to);
  const relative = path.relative(source, destination);
  const reverse = path.relative(destination, source);
  const inside = (value) => value === '' || (!path.isAbsolute(value)
    && value !== '..' && !value.startsWith(`..${path.sep}`));
  if (inside(relative) || inside(reverse)) throw new Error(`Run store paths overlap: ${from} and ${to}.`);
  const oldEntries = inspectRunStore(from).entries;
  const newEntries = inspectRunStore(to).entries;
  const paths = [];
  let count = 0;
  for (const [entryPath, oldEntry] of oldEntries) {
    const newEntry = newEntries.get(entryPath);
    if (!newEntry || oldEntry.directory !== newEntry.directory
      || (!oldEntry.directory && (oldEntry.size !== newEntry.size
        || hash(path.join(from, entryPath)) !== hash(path.join(to, entryPath))))) {
      count += 1;
      if (paths.length < 20) paths.push(entryPath);
    }
  }
  return { paths, count };
}

function differencesResult(from, { paths, count }) {
  return { exitCode: 1,
    output: `The old folder ${from} has ${count} entries the new store does not hold identically:\n${paths.join('\n')}\nNothing was removed.` };
}

export async function removeOldStore({ from, to, ask = askYesNo, interactive = isInteractive,
  questionOptions = {}, hash }) {
  let quarantine;
  const restore = () => {
    if (!quarantine) return '';
    if (!fs.existsSync(from)) {
      try {
        fs.renameSync(quarantine, from);
        quarantine = undefined;
        return '';
      } catch (error) {
        return `\nCould not restore ${quarantine} to ${from}: ${error.message}. Records remain in ${quarantine}.`;
      }
    }
    return `\nThe old records remain in ${quarantine}; ${from} also exists. Both folders were kept.`;
  };
  try {
    const differences = oldStoreDifferences({ from, to, hash });
    if (differences.count) return differencesResult(from, differences);
    if (!interactive(questionOptions)) {
      return { exitCode: 0,
        output: `The old folder ${from} is still there; run codex-bridge runs move in a terminal to remove it.` };
    }
    const answer = await ask(`Remove the old folder ${from}? Every file in it has an identical copy in ${to}. `
      + 'It stays in the history of the git repository that holds it until that project commits the removal.', questionOptions);
    if (answer === 'cancel') return { exitCode: 130, output: 'Cancelled; nothing was removed.' };
    if (answer !== 'yes') return { exitCode: 0, output: 'The old folder was kept.' };
    // Plan_77 F1: isolate the old tree before comparing; never delete a newly recreated from.
    const isolated = `${from}.removing-${process.pid}-${Date.now()}`;
    try {
      fs.renameSync(from, isolated);
    } catch (error) {
      if (['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) {
        return { exitCode: 1,
          output: `A process still uses a file in ${from}; nothing was removed. Close it and repeat.` };
      }
      throw error;
    }
    quarantine = isolated;
    const confirmed = oldStoreDifferences({ from: quarantine, to, hash });
    if (confirmed.count) {
      const result = differencesResult(from, confirmed);
      result.output += restore();
      return result;
    }
    fs.rmSync(quarantine, { recursive: true });
    quarantine = undefined;
    return { exitCode: 0, output: `Removed ${from}.` };
  } catch (error) {
    return { exitCode: 1, output: `${error.message}\nNothing was removed.${restore()}` };
  }
}
