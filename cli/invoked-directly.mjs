/** Decides whether this process was started as the CLI or merely imported by another module. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolves a path through symlinks, falling back to plain resolution when that is impossible.
 *
 * This is the one place in the package where symlinks are deliberately resolved. Everywhere else
 * they are not — realpath returns `\\?\` and UNC spellings, and host paths are compared as written.
 * Here the question is not which path a file has but whether two paths name the same file, and
 * both sides go through the same function, so the exotic spellings match each other.
 */
function sameFileKey(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * True when argv[1] names this very module.
 *
 * Comparing the two paths as written looked equivalent until `npm i -g .` linked the global
 * package at the clone: argv[1] then held the path inside the global node_modules while
 * import.meta.url held the clone, because Node resolves the module's own URL through the link and
 * argv[1] keeps the spelling used to start it. The comparison failed, main() never ran, and the
 * CLI exited 0 having printed nothing. That silence was the dangerous part — every guard is a hook
 * that must print a refusal to refuse anything, so five guards went on reporting `[ok]` in doctor
 * while permitting everything the operator installed them to stop (2026-08-11).
 */
export function isInvokedDirectly(argv1, moduleUrl) {
  if (!argv1 || !moduleUrl) return false;
  const modulePath = moduleUrl.startsWith('file:') ? fileURLToPath(moduleUrl) : moduleUrl;
  return sameFileKey(argv1) === sameFileKey(modulePath);
}
