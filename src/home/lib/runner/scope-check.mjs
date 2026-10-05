/**
 * Answers whether each scope pattern can match an existing repository file.
 *
 * Plan_27 moved impossible scope failures before the run folder: an absolute pattern had already
 * spent 18 minutes before the verdict proved that it matched nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { listRepositoryPaths } from './git-paths.mjs';
import { globToRegExp, normalizePath, SERVICE_RE } from '../meta/paths.mjs';
import { orderInputName } from '../order-schema.mjs';

// Directories a self-walk must never descend into. Only reached when the repository has no git:
// with git present the file list comes from the repository itself, which already knows what is
// ignored. The first Plan_27 pass walked everything, `.git` and `node_modules` included — invisible
// here, where the package has no dependencies, and tens of thousands of files in a working monorepo.
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules']);

function absolutePattern(pattern) {
  return (
    /^[A-Za-z]:/.test(pattern) ||
    pattern.startsWith('/') ||
    pattern.startsWith('\\\\?\\') ||
    pattern.startsWith('\\\\')
  );
}

function structuralRefusal(repoRoot, pattern) {
  // Plan_73 D7: scope lists store one pattern per line; literal line breaks cannot round-trip.
  if (/[\n\r]/.test(pattern)) {
    return {
      reason: 'contains a newline or carriage return',
      action: 'use a glob instead of a literal path containing a line break',
    };
  }
  if (absolutePattern(pattern)) {
    return {
      reason: 'is an absolute or drive-qualified path',
      action: 'use a path relative to the repository root with forward slashes',
    };
  }
  if (pattern.includes('\\')) {
    return {
      reason: 'uses backslash separators',
      action: 'replace backslashes with forward slashes',
    };
  }
  if (pattern.split('/').some((segment) => segment === '..')) {
    return {
      reason: 'contains a parent-directory (..) segment',
      action: 'remove the .. segment and keep the path relative to the repository root',
    };
  }
  // Plan_59 S1: 2026-09-22_235724_plan59-d1-advisor-docs-surface spent 22 minutes on a
  // service-directory scope the verdict could never authorise. Refuse it before a run exists.
  if (SERVICE_RE.test(normalizePath(pattern))) {
    return {
      reason: 'lies inside a service directory that no scope can authorise',
      action: 'name the file outside the service directory, or make that edit yourself',
    };
  }
  // Plan_58 D7: 2026-09-19_191402_ports-infra spent a run on a bare scope-new directory,
  // which the verdict could only match as a file. Refuse that intent before spending a run.
  if (!pattern || /[*?]/.test(pattern)) return null;
  const reason = 'names a directory rather than a file';
  const action = `write ${pattern.replace(/\/$/, '')}/** for everything inside it, or name the file itself`;
  if (pattern.endsWith('/')) return { reason, action };

  let entry;
  try {
    entry = fs.statSync(path.join(repoRoot, pattern));
  } catch {
    // An unreadable or vanished path is treated as missing, so only its spelling is checked.
  }
  if (entry?.isDirectory()) return { reason, action };
  if (!entry && !pattern.split('/').at(-1).includes('.')) {
    return {
      reason,
      action: `write ${pattern}/** if it is a directory, or declare the new file by its own name with an extension; a new extensionless file is declared through its directory`,
    };
  }
  return null;
}

function noMatchRefusal(pattern, repoRoot, gitListed) {
  // OW-042: order plan72-r3-b1-live-thresholds-20261001 ran from a folder outside git, the walk missed a tracked
  // file, and the refusal claimed the file did not exist. A walked folder is not the repository git would list.
  if (gitListed === false) {
    return {
      pattern,
      reason: `does not match any existing path under ${repoRoot}; ` +
        'git could not list that folder as a repository, so it was walked instead',
      action: `start the run from the repository root (cd into it, or pass ${orderInputName('repository')} <repository root>); ` +
        'if this folder is the intended one, correct the pattern',
    };
  }
  return {
    pattern,
    reason: 'does not match any existing path in the repository',
    action: `correct the pattern or declare an intentionally new path with ${orderInputName('scope new')}`,
  };
}

function repositoryPath(repoRoot, absolutePath) {
  const relative = path.relative(repoRoot, absolutePath).split(path.sep).join('/');
  return normalizePath(relative);
}

/** Walks a directory that has no git, skipping dependency trees and anything unreadable. */
function walkPaths(repoRoot) {
  const pending = [repoRoot];
  const found = [];
  while (pending.length) {
    const current = pending.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      // An unreadable subdirectory is not a reason to refuse a run: the pattern may well match
      // somewhere else, and a permission error here would fail work that has nothing to do with it.
      continue;
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) pending.push(absolute);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      found.push(repositoryPath(repoRoot, absolute));
    }
  }
  return found;
}

/**
 * Names come from git-paths.mjs so Plan_73's 2026-09-30 Cyrillic incident cannot recur through
 * quoted git output or trimmed names. Its tracked-plus-untracked, non-ignored list costs one
 * process instead of a walk and cannot wander into `.git` or a dependency tree.
 */
function matchingPaths(repoRoot, matchers) {
  const listed = listRepositoryPaths(repoRoot);
  const candidates = listed ?? walkPaths(repoRoot);
  const matched = new Set();
  for (const candidate of candidates) {
    for (const matcher of matchers) {
      if (!matched.has(matcher.pattern) && matcher.regexp.test(candidate)) {
        matched.add(matcher.pattern);
      }
    }
    if (matched.size === matchers.length) break;
  }
  return { matched, gitListed: listed !== null };
}

function patternList(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value.map((pattern) => {
    const text = String(pattern ?? '');
    return /[\n\r]/.test(text) ? text : text.trim();
  });
}

/**
 * Returns the first scope refusal, or null when every ordinary pattern can match a repository
 * path. New-file declarations are still structurally checked; only their existence check is
 * exempted.
 */
export function validateScope(repoRoot, patterns, scopeNewPatterns = []) {
  if (typeof repoRoot !== 'string' || !repoRoot) throw new TypeError('repoRoot must be a non-empty string');
  const declared = patternList(patterns, 'patterns');
  const newPaths = patternList(scopeNewPatterns, 'scopeNewPatterns');
  const allPatterns = [...declared, ...newPaths];
  const newPathKeys = new Set(newPaths.map((pattern) => normalizePath(pattern)));

  // The flag is decided by --scope-new membership, not list position: args.mjs merges every --scope-new
  // pattern into the declared list, so position named --scope for a directory given only to --scope-new
  // (OW-042 B1, caught on the live runner 2026-10-04 after the unit test passed separate lists).
  for (const pattern of allPatterns) {
    const label = newPathKeys.has(normalizePath(pattern)) ? 'scope new' : 'scope';
    const refusal = structuralRefusal(repoRoot, pattern);
    if (refusal) return { pattern, label, ...refusal };
    if (!pattern) return { ...noMatchRefusal(pattern), label };
  }

  const required = allPatterns.filter((pattern) => !newPathKeys.has(normalizePath(pattern)));
  if (!required.length) return null;

  let matchers;
  try {
    matchers = required.map((pattern) => ({ pattern, regexp: globToRegExp(pattern) }));
  } catch (error) {
    return {
      pattern: required[0],
      label: 'scope',
      reason: `could not parse the pattern: ${error.message}`,
      action: 'correct the pattern and retry',
    };
  }

  let matches;
  try {
    matches = matchingPaths(repoRoot, matchers);
  } catch (error) {
    if (error.code !== 'ERR_GIT_PATH_NOT_UTF8') throw error;
    return {
      pattern: required[0],
      label: 'scope',
      reason: error.message,
      action: 'rename the non-UTF-8 file using a UTF-8 file name and retry',
    };
  }
  const missing = matchers.find((matcher) => !matches.matched.has(matcher.pattern));
  return missing ? { ...noMatchRefusal(missing.pattern, repoRoot, matches.gitListed), label: 'scope' } : null;
}
