/**
 * Removes shared image files only with content evidence (Plan_65 D10 item 3), so operator edits
 * are preserved and named instead of being lost during uninstall.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildInstallPlan, contentFingerprint } from './manifest.mjs';
import { plannedContent } from './copy.mjs';
import { fingerprintFor, recordTarget } from './install-record.mjs';
import { recordHomeWriter, removeRecordedFile } from './record-removal.mjs';

function displayFile(file) {
  return `brand/${file.path}`;
}

function leftLine(file, reason, dryRun) {
  return `${dryRun ? 'Would leave' : 'Left'} ${displayFile(file)} (${reason})`;
}

export async function removeImageFiles(host, files, fingerprints, { dryRun = false, packageRoot } = {}) {
  const plan = await buildInstallPlan(host, packageRoot);
  const planByPath = new Map(plan
    .filter((item) => item.root === 'brand')
    .map((item) => [item.relativeToRoot, item]));
  const writer = dryRun ? null : recordHomeWriter(host, files);
  const lines = [];

  for (const file of files) {
    const target = recordTarget(host, file);
    let stat;
    try {
      stat = await fs.lstat(target);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      lines.push(leftLine(file, `unreadable: ${error.code ?? 'UNKNOWN'}`, dryRun));
      continue;
    }
    if (stat.isSymbolicLink()) {
      lines.push(leftLine(file, 'link', dryRun));
      continue;
    }

    let bytes;
    try {
      bytes = await fs.readFile(target);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      lines.push(leftLine(file, `unreadable: ${error.code ?? 'UNKNOWN'}`, dryRun));
      continue;
    }

    const recorded = fingerprintFor({ fingerprints }, file);
    const matchesRecord = typeof recorded === 'string' && contentFingerprint(bytes) === recorded;
    const item = planByPath.get(file.path);
    const matchesPackage = !matchesRecord && item
      ? bytes.equals(await plannedContent(item, host.brandRoot))
      : false;
    if (matchesRecord || matchesPackage) {
      if (!dryRun) {
        const { kept } = await removeRecordedFile(host, writer, file);
        if (kept) {
          const reason = kept.kind === 'link'
            ? `link at ${path.relative(host.brandRoot, kept.at).split(path.sep).join('/')}`
            : `unreadable: ${kept.code ?? kept.kind}`;
          lines.push(leftLine(file, reason, dryRun));
          continue;
        }
      }
      lines.push(`${dryRun ? 'Would remove' : 'Removed'} ${displayFile(file)}`);
    } else {
      lines.push(leftLine(file, 'changed', dryRun));
    }
  }

  return { lines };
}
