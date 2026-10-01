/**
 * Removes files listed in an installation record through the home adapter, so uninstall and update
 * cannot remove an unregistered path from the package home.
 */
import fs from 'node:fs/promises';
import { createHomeWriter } from '../src/home/lib/home-write.mjs';
import { recordTarget } from './install-record.mjs';
import { claudeBoundary, removeEmptyParents, removeEmptyHomeParents } from './remove-layout.mjs';
import { inspectSegments } from './link-segments.mjs';

export function recordHomeWriter(host, files) {
  const imageMembers = files.filter((entry) => entry.root === 'brand').map((entry) => entry.path);
  return createHomeWriter({ root: host.brandRoot, imageMembers });
}

export async function removeRecordedFile(host, writer, entry) {
  const target = recordTarget(host, entry);
  if (entry.root === 'brand') {
    // Plan_65 D4 item 4 covers unlink too: a real file can sit beneath a junction.
    const finding = inspectSegments(target, host.brandRoot);
    if (finding.kind !== 'clear' && finding.kind !== 'missing') return { kept: finding };
    if (finding.kind === 'clear') {
      try {
        await writer.unlink('install-image', target);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
    // A file already gone still gets its emptied parents taken down: a repeated uninstall after a
    // partial one must finish the folders the first run left. The segments were just checked, so a
    // link the walk finds now is a race; it stops the walk, and the file's own outcome is reported.
    await removeEmptyHomeParents(writer, 'install-image', target, host.brandRoot);
  } else {
    await removeOutside(writer, target);
    await removeEmptyParents(target, claudeBoundary(host, target));
  }
  return { kept: null };
}

export async function removeOutside(writer, target) {
  writer.assertOutside(target);
  await fs.rm(target, { force: true });
}
