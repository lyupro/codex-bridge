/** Copies planned install files atomically and compares their rendered contents. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { replacePlaceholders } from './manifest.mjs';

export async function plannedContent(item, agentsDir) {
  const source = await fs.readFile(item.source);
  if (item.processing === 'copy') return source;
  if (item.processing === 'placeholders') {
    return Buffer.from(replacePlaceholders(source.toString('utf8'), agentsDir));
  }
  throw new Error(`unknown install processing "${item.processing}"`);
}

export async function targetMatches(item, agentsDir) {
  const expected = await plannedContent(item, agentsDir);
  try {
    const actual = await fs.readFile(item.target);
    return actual.equals(expected);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR') return false;
    throw err;
  }
}

export async function copyPlannedFile(item, agentsDir) {
  const content = await plannedContent(item, agentsDir);
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
