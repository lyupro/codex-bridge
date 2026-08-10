/** Copies planned install files atomically and compares their rendered contents. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { replacePlaceholders } from './manifest.mjs';

export async function plannedContent(item, installationRoot) {
  const replacementRoot = item.installationRoot ?? installationRoot;
  const source = await fs.readFile(item.source);
  if (item.processing === 'copy') return source;
  if (item.processing === 'placeholders') {
    return Buffer.from(replacePlaceholders(source.toString('utf8'), replacementRoot));
  }
  throw new Error(`unknown install processing "${item.processing}"`);
}

export async function targetMatches(item, installationRoot) {
  const expected = await plannedContent(item, installationRoot);
  try {
    const actual = await fs.readFile(item.target);
    return actual.equals(expected);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR') return false;
    throw err;
  }
}

export async function copyPlannedFile(item, installationRoot) {
  const content = await plannedContent(item, installationRoot);
  await fs.mkdir(path.dirname(item.target), { recursive: true });
  const temporary = path.join(path.dirname(item.target), `.${path.basename(item.target)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, content, { flag: 'wx' });
    await fs.rename(temporary, item.target);
  } catch (err) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw err;
  }
}
