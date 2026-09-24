/** Copies the package home files into a temp tree, matching the installer's runtime image. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempTree, removeTempTree } from './temp-tree.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function makeHomeImage(t) {
  const root = makeTempTree('home-image-');
  t.after(() => removeTempTree(root));
  await fs.cp(path.join(ROOT, 'src', 'home'), root, { recursive: true });
  await fs.copyFile(path.join(ROOT, 'package.json'), path.join(root, 'package.json'));
  return root;
}
