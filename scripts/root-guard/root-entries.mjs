/**
 * Names additions to a directory's direct filesystem entries without deleting anything.
 * On 2026-09-24 a suite run left Microsoft/Windows/PowerShell/ModuleAnalysisCache in the
 * repository root; git cannot witness ignored entries, so this guard reads the filesystem.
 */
import fs from 'node:fs';

export function snapshotRoot(dir) {
  return fs.readdirSync(dir).sort();
}

export function addedEntries(before, after) {
  const previous = new Set(before);
  return after.filter((name) => !previous.has(name));
}
