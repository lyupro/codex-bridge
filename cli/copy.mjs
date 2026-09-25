/** Copies planned install files atomically and compares their rendered contents. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { classifyHomePath } from '../src/home/lib/home-registry.mjs';
import { createHomeWriter } from '../src/home/lib/home-write.mjs';
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

/**
 * Plan_65 D3: the install image is one registry entry whose exact members come from the plan, and
 * seeds keep their own ids. One place decides which id a planned item writes under, so the
 * installer and every fixture that copies a plan cannot disagree about it.
 */
export function planHomeWriter(brandRoot, plan) {
  const imageMembers = plan.filter((item) => item.root === 'brand').map((item) => item.relativeToRoot);
  const writer = createHomeWriter({ root: brandRoot, imageMembers });
  const idFor = (item) => {
    if (item.root !== 'brand') return undefined;
    const id = classifyHomePath(item.relativeToRoot, { imageMembers })?.id;
    if (!id) throw new Error(`brand install plan item is not a registered home artifact: ${item.relativeToRoot}`);
    return id;
  };
  return { writer, idFor };
}

export async function copyPlannedFile(item, installationRoot, options = {}) {
  const { writer, id } = options ?? {};
  if (!writer) throw new Error('copyPlannedFile requires a home writer');
  if (id !== undefined) await writer.assertArtifact(id, item.target);
  else await writer.assertOutside(item.target);

  const content = await plannedContent(item, installationRoot);
  const operations = id === undefined
    ? {
      mkdir: (...args) => fs.mkdir(...args),
      writeFile: (...args) => fs.writeFile(...args),
      rename: (...args) => fs.rename(...args),
      cleanup: (temporary) => fs.rm(temporary, { force: true }),
    }
    : {
      mkdir: (...args) => writer.mkdir(id, ...args),
      writeFile: (...args) => writer.writeFile(id, ...args),
      rename: (...args) => writer.rename(id, ...args),
      cleanup: (temporary) => writer.unlink(id, temporary),
    };
  await operations.mkdir(path.dirname(item.target), { recursive: true });
  const temporary = path.join(path.dirname(item.target), `.${path.basename(item.target)}.${randomUUID()}.tmp`);
  try {
    await operations.writeFile(temporary, content, { flag: 'wx' });
    await operations.rename(temporary, item.target);
  } catch (err) {
    await Promise.resolve().then(() => operations.cleanup(temporary)).catch(() => {});
    throw err;
  }
}
