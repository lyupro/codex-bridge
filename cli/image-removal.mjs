/**
 * Removes shared image files only with content evidence (Plan_65 D10 item 3), so operator edits
 * are preserved and named instead of being lost during uninstall.
 */
import path from 'node:path';
import { imagePackageIndex, judgeImageFile } from './image-evidence.mjs';
import { recordHomeWriter, removeRecordedFile } from './record-removal.mjs';

function displayFile(file) {
  return `brand/${file.path}`;
}

function leftLine(file, reason, dryRun) {
  return `${dryRun ? 'Would leave' : 'Left'} ${displayFile(file)} (${reason})`;
}

export async function removeImageFiles(host, files, fingerprints, { dryRun = false, packageRoot } = {}) {
  const packageIndex = await imagePackageIndex(host, packageRoot);
  const writer = dryRun ? null : recordHomeWriter(host, files);
  const lines = [];

  for (const file of files) {
    const { verdict, reason } = await judgeImageFile(host, file, fingerprints, packageIndex);
    if (verdict === 'missing') continue;
    if (verdict === 'keep') {
      lines.push(leftLine(file, reason, dryRun));
      continue;
    }
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
  }

  return { lines };
}
