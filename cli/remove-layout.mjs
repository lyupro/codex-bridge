/** Removes emptied directories of an installed layout without walking out of the package's own. */
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * These four helpers existed as two copies — one in uninstall.mjs, one in update.mjs — and the
 * copies had already drifted before this file was written: update's removeEmptyParents inlined the
 * readdir/rmdir pair instead of calling removeEmpty, and only uninstall's removeEmptyLayout
 * guarded a missing directory. Nothing failed, which is exactly the problem: the same divergence
 * between the installer's file list and the hook's list went unnoticed until Plan_19 had to
 * reconcile them. Removal logic decides what disappears from the operator's ~/.claude, so it gets
 * one definition.
 */

export async function removeEmpty(directory) {
  try {
    if ((await fs.readdir(directory)).length === 0) await fs.rmdir(directory);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

export async function removeEmptyParents(target, boundary) {
  let current = path.dirname(target);
  while (current !== boundary && current.startsWith(`${boundary}${path.sep}`)) {
    await removeEmpty(current);
    current = path.dirname(current);
  }
}

/**
 * The directory an emptied-parent walk must stop at. Plan_25 gave the host four package-owned
 * directories at once — the current agents and commands subdirectories and the two the previous
 * layout used — and a walk that started inside one of them but stopped at host.root would delete
 * the operator's own emptied directories on the way up.
 */
export function claudeBoundary(host, target) {
  const directories = [
    host.agentsDir,
    host.commandsDir,
    host.legacyAgentsDir,
    host.legacyCommandsDir,
  ].filter(Boolean);
  return directories.find((directory) => target === directory
    || target.startsWith(`${directory}${path.sep}`)) || host.root;
}

/** Takes down one layout directory and whatever it leaves empty behind it, up to the boundary. */
export async function removeEmptyLayout(directory, boundary) {
  await removeEmpty(directory);
  await removeEmptyParents(directory, boundary);
}
