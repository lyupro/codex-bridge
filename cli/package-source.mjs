/**
 * Which copy of the package is answering, and whether the operator is standing in another one.
 *
 * Plan_19 gives the CLI a second name, and a global install puts a second copy of the package on
 * the machine beside any clone. Every command copies host files from whichever copy launched it,
 * so the answer depends on which copy that was — and until 2026-09-07 only `doctor` said so. That
 * day the operator ran `codex-bridge update --force` from a 0.6.0 clone while PATH still held the
 * previous release: the command compared the home against its OWN files, found them current, and
 * answered "codex-bridge is up to date" without naming the package it meant. The fix is not a
 * second detector — it is this one, shared.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonFileSync } from '../src/home/lib/json-file.mjs';

const PACKAGE_NAME = '@lyupro/codex-bridge';

/** The kind of the copy at a known root. A path separator on Windows is a backslash too. */
export function sourceAt(root) {
  const resolved = path.resolve(root);
  return {
    root: resolved,
    kind: resolved.split(/[\\/]/).includes('node_modules') ? 'installed copy' : 'clone',
  };
}

export function packageSource() {
  return sourceAt(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
}

function readPackage(file) {
  try {
    const value = readJsonFileSync(file);
    return value?.name === PACKAGE_NAME && typeof value.version === 'string' ? value : null;
  } catch {
    // A directory that merely holds an unreadable package.json is not a checkout of this package.
    return null;
  }
}

/**
 * The checkout the operator is standing in, when that is a different copy than the one running.
 * Walking up from the working directory is how the case reproduces: the operator was inside the
 * clone, the command came from PATH, and nothing in the answer connected the two.
 */
export function checkoutAt(cwd = process.cwd(), source = packageSource()) {
  let directory = path.resolve(cwd);
  for (;;) {
    const found = readPackage(path.join(directory, 'package.json'));
    if (found) {
      return path.resolve(directory) === path.resolve(source.root)
        ? null
        : { root: directory, version: found.version, name: found.name };
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}
