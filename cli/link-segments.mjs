/**
 * Says whether a delete target is reached only through real directories below a trusted root.
 *
 * Lexical containment alone is satisfiable: independent review replaced `<root>/<project>` with a
 * junction to an outside directory, and a target that still spelled out as inside the root deleted
 * what was outside it. Paths are deliberately never resolved (`realpath` returns `\\?\` and UNC
 * forms on Windows and creates a new class of mismatch), so every segment is checked with lstat,
 * top-down, right before deletion. Plan_65 D4 made this one module for prune and the coming purge
 * after prune's own copy was found wrong twice: it walked from the leaf up, touching paths under a
 * link before reaching the link, and it read every lstat error as a clear path. Only ENOENT means
 * gone here; any other error is a finding, and the caller keeps the entry. The root itself is taken
 * as written, because relocating the runs root or the home through a link is legitimate.
 * Containment compares through normalizePath, which folds Windows case: a root spelled `C:\Users`
 * against a target resolved as `c:\users` must not read as "outside".
 */
import fs from 'node:fs';
import path from 'node:path';
import { normalizePath } from '../src/home/hooks/live-runs.mjs';

export function inspectSegments(target, root, { lstat = (file) => fs.lstatSync(file) } = {}) {
  const normalizedRoot = normalizePath(root);
  const normalizedTarget = normalizePath(target);
  if (!normalizedRoot || !normalizedTarget) return { kind: 'outside' };

  const rootPrefix = normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`;
  if (normalizedTarget === normalizedRoot || !normalizedTarget.startsWith(rootPrefix)) {
    return { kind: 'outside' };
  }

  const rootPath = path.resolve(root);
  const relativeTarget = path.relative(rootPath, path.resolve(target));
  let current = rootPath;
  for (const segment of relativeTarget.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let entry;
    try {
      entry = lstat(current);
    } catch (error) {
      if (error.code === 'ENOENT') return { kind: 'missing', at: current };
      return { kind: 'error', at: current, code: error.code };
    }
    if (entry.isSymbolicLink()) return { kind: 'link', at: current };
  }
  return { kind: 'clear' };
}