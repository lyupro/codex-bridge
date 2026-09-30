/**
 * One responsibility: every git call that lists repository paths runs here with `-z` and returns exact names.
 * On 2026-09-30, quoted octal escapes for areas/tickets-и-notifier.md made scope preflight
 * refuse both its literal path and an ASCII glob, blocking a vault with Cyrillic file names.
 */
import { spawnSync } from 'node:child_process';

function pathRecords(repoRoot, args) {
  const result = spawnSync(
    'git',
    ['-C', repoRoot, ...args],
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

export function listRepositoryPaths(repoRoot) {
  return pathRecords(repoRoot, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
}

export function listUntrackedPaths(repoRoot) {
  return pathRecords(repoRoot, ['ls-files', '-z', '-o', '--exclude-standard']);
}

export function numstatRows(repoRoot) {
  const records = pathRecords(repoRoot, ['diff', 'HEAD', '--numstat', '--no-renames', '-z']);
  if (records === null) return null;
  return records.map((record) => {
    const firstTab = record.indexOf('\t');
    const secondTab = record.indexOf('\t', firstTab + 1);
    return {
      added: record.slice(0, firstTab),
      deleted: record.slice(firstTab + 1, secondTab),
      path: record.slice(secondTab + 1),
    };
  });
}

// The owner spells each command whole: a caller that composes path-listing arguments itself is what
// tests/git-path-listing-guard.test.mjs exists to catch.
export function diffNames(repoRoot, range) {
  return pathRecords(repoRoot, ['diff', '--name-only', '-z', range]);
}

export function commitNames(repoRoot, sha) {
  return pathRecords(repoRoot, ['show', '--name-only', '--format=', '-z', sha]);
}

export function porcelainPaths(repoRoot) {
  const records = pathRecords(repoRoot, ['status', '--porcelain', '-z']);
  if (records === null) return null;
  const names = new Set();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    names.add(record.slice(3));
    if (record[0] === 'R' || record[1] === 'R' || record[0] === 'C' || record[1] === 'C') {
      names.add(records[++index]);
    }
  }
  return [...names];
}
