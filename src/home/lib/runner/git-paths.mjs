/**
 * One responsibility: every git call that lists repository paths runs here with `-z` and returns exact names.
 * On 2026-09-30, quoted octal escapes for areas/tickets-и-notifier.md made scope preflight
 * refuse both its literal path and an ASCII glob, blocking a vault with Cyrillic file names.
 */
import { spawnSync } from 'node:child_process';

export function listRepositoryPaths(repoRoot) {
  const result = spawnSync(
    'git',
    ['-C', repoRoot, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error || result.status !== 0) return null;

  let output;
  try {
    // A leading BOM can be part of the first name, so decoding must preserve it too.
    output = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(result.stdout);
  } catch (cause) {
    const error = new Error(`Repository ${repoRoot} contains a file name that is not UTF-8`, { cause });
    error.code = 'ERR_GIT_PATH_NOT_UTF8';
    throw error;
  }
  const names = output.split('\0');
  if (names.at(-1) === '') names.pop();
  return names;
}
