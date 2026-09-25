/**
 * Removes files listed in an installation record through the home adapter, so uninstall and update
 * cannot remove an unregistered path from the package home.
 */
import fs from 'node:fs/promises';
import { createHomeWriter } from '../src/home/lib/home-write.mjs';
import { recordTarget } from './install-record.mjs';
import { claudeBoundary, removeEmptyParents } from './remove-layout.mjs';

export function recordHomeWriter(host, files) {
  const imageMembers = files.filter((entry) => entry.root === 'brand').map((entry) => entry.path);
  return createHomeWriter({ root: host.brandRoot, imageMembers });
}

export async function removeRecordedFile(host, writer, entry) {
  const target = recordTarget(host, entry);
  if (entry.root === 'brand') {
    try {
      await writer.unlink('install-image', target);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  } else {
    await removeOutside(writer, target);
  }
  const boundary = entry.root === 'brand' ? host.brandRoot : claudeBoundary(host, target);
  await removeEmptyParents(target, boundary);
}

export async function removeOutside(writer, target) {
  writer.assertOutside(target);
  await fs.rm(target, { force: true });
}
