/**
 * Applies a host inspection by removing eligible host files and this package's hooks (Plan_65 D10
 * items 3 and 4). The shared image is left for uninstall, which may remove it only after the host
 * has no hook pointing to it.
 */
import { recordHomeWriter, removeOutside } from './record-removal.mjs';
import { claudeBoundary, removeEmptyParents } from './remove-layout.mjs';
import { recordTarget } from './install-record.mjs';
import { commandFor, removeHook, shortCommandFor } from './settings-merge.mjs';
import { normalizeRepoPath } from '../src/home/lib/runner/project-dir.mjs';

// Plan_65 D10 item 5: only the host's own owner entry proves we created a group; legacy never does.
function recordedCreation(owner, host, found) {
  if (!owner || !found.name || normalizeRepoPath(owner.root) !== normalizeRepoPath(host.root)) return false;
  return (owner.hooks ?? []).some((hook) => {
    if (hook?.event !== found.event || hook.createdGroup !== true) return false;
    let command = hook.command;
    if (typeof command !== 'string') {
      try {
        command = commandFor(recordTarget(host, hook));
      } catch {
        return false;
      }
    }
    return command === found.command || command === shortCommandFor(found.name);
  });
}

// Decided per group before anything is removed: with two own hooks in one group and evidence on
// only one, a per-hook flag made the outcome depend on removal order. removeHook drops a group
// only once it is empty, so an emptied group we created goes and a shared one stays.
function createdGroups(owner, host, hooks) {
  const created = new Set();
  for (const hook of hooks) {
    if (recordedCreation(owner, host, hook)) created.add(`${hook.event}#${hook.groupIndex}`);
  }
  return created;
}

export async function removeHostSide(host, inspection, { owner = null, dryRun = false } = {}) {
  const lines = [];
  const writer = dryRun ? null : recordHomeWriter(host, []);
  for (const file of inspection.files) {
    if (file.disposition === 'remove') {
      if (!dryRun) {
        await removeOutside(writer, file.target);
        await removeEmptyParents(file.target, claudeBoundary(host, file.target));
      }
      lines.push(`${dryRun ? 'Would remove' : 'Removed'} ${file.relativeToHost}`);
    } else {
      lines.push(`Left ${file.relativeToHost} (${file.reason})`);
    }
  }

  if (inspection.settingsError != null) {
    lines.push(`Left the hooks in ${host.settingsPath}: ${inspection.settingsError}`);
    return { lines, detached: false };
  }

  let detached = true;
  const created = createdGroups(owner, host, inspection.hooks);
  for (const hook of inspection.hooks) {
    const identity = hook.name ?? hook.command;
    if (dryRun) {
      lines.push(`Would remove the ${hook.event} hook ${identity}`);
      continue;
    }
    try {
      await removeHook(host.settingsPath, {
        event: hook.event,
        matcher: hook.matcher,
        command: hook.command,
        alternateCommands: [],
      }, { createdGroup: created.has(`${hook.event}#${hook.groupIndex}`) });
      lines.push(`Removed the ${hook.event} hook ${identity}`);
    } catch (error) {
      detached = false;
      lines.push(`Failed to remove the ${hook.event} hook ${identity}: ${error?.message ?? String(error)}`);
    }
  }
  return { lines, detached };
}