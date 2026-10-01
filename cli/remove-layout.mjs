/**
 * Removes emptied directories of an installed layout without walking out of the package's own.
 * Home folders use the adapter and link check (Plan_65 D3, D4 item 4); host folders keep the raw route.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { inspectSegments } from './link-segments.mjs';

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

/**
 * Takes down one emptied package-owned layout directory — and stops there.
 *
 * It deliberately does not walk into the parent: the parents here are `~/.claude/agents` and
 * `~/.claude/commands`, which belong to Claude Code and are shared with every other agent the
 * operator has. An operator whose only agents were ours would have had those directories deleted
 * out from under Claude Code by an uninstall that was asked to remove our files. Directories
 * *inside* our own are a different case and are still walked, bounded by claudeBoundary().
 */
export async function removeEmptyLayout(directory) {
  await removeEmpty(directory);
}

// The segment check runs before every rmdir, not once per walk: on Windows rmdir on a junction
// removes the junction itself, and a folder above the target may be a link even when the target's
// own folder is not. A folder already gone keeps the walk going — its parent may still be empty.
export async function removeEmptyHomeParents(writer, id, target, homeRoot) {
  const root = path.resolve(homeRoot);
  let current = path.dirname(path.resolve(target));
  for (;;) {
    const relative = path.relative(root, current);
    if (!relative || path.isAbsolute(relative) || relative === '..'
      || relative.startsWith(`..${path.sep}`)) break;

    const finding = inspectSegments(current, root);
    if (finding.kind !== 'missing') {
      if (finding.kind !== 'clear') return { kept: finding };
      try {
        if ((await fs.readdir(current)).length !== 0) break;
        await writer.rmdir(id, current);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    current = path.dirname(current);
  }
  return { kept: null };
}

export async function removeEmptyHome(writer, id, homeRoot) {
  // Plan_65 D4 item 1 trusts the root as written, including a deliberately relocated home.
  try {
    if ((await fs.readdir(homeRoot)).length === 0) await writer.rmdir(id, homeRoot);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
