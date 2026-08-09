/**
 * Answers whether each scope pattern can match an existing repository file.
 *
 * Plan_27 moved impossible scope failures before the run folder: an absolute pattern had already
 * spent 18 minutes before the verdict proved that it matched nothing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { globToRegExp, normalizePath } from '../meta/paths.mjs';

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

function structuralRefusal(pattern) {
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
  return null;
}

function noMatchRefusal(pattern) {
  return {
    pattern,
    reason: 'does not match any existing path in the repository',
    action: 'correct the pattern or declare an intentionally new path with --scope-new',
  };
}

function repositoryPath(repoRoot, absolutePath) {
  const relative = path.relative(repoRoot, absolutePath).split(path.sep).join('/');
  return normalizePath(relative);
}

/**
 * The repository's own answer to "which files are there": tracked plus new-but-uncommitted, minus
 * everything ignored. It is the same boundary the run is judged by afterwards, it costs one process
 * instead of a full walk, and it cannot wander into `.git` or a dependency tree.
 */
function gitPaths(repoRoot) {
  const result = spawnSync(
    'git',
    ['-C', repoRoot, 'ls-files', '--cached', '--others', '--exclude-standard'],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.error || result.status !== 0) return null;
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
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

function matchingPaths(repoRoot, matchers) {
  const candidates = gitPaths(repoRoot)?.map((relative) => normalizePath(relative))
    ?? walkPaths(repoRoot);
  const matched = new Set();
  for (const candidate of candidates) {
    for (const matcher of matchers) {
      if (!matched.has(matcher.pattern) && matcher.regexp.test(candidate)) {
        matched.add(matcher.pattern);
      }
    }
    if (matched.size === matchers.length) break;
  }
  return matched;
}

function patternList(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value.map((pattern) => String(pattern ?? '').trim());
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

  for (const pattern of allPatterns) {
    const refusal = structuralRefusal(pattern);
    if (refusal) return { pattern, ...refusal };
    if (!pattern) return noMatchRefusal(pattern);
  }

  const newPathKeys = new Set(newPaths.map((pattern) => normalizePath(pattern)));
  const required = allPatterns.filter((pattern) => !newPathKeys.has(normalizePath(pattern)));
  if (!required.length) return null;

  let matchers;
  try {
    matchers = required.map((pattern) => ({ pattern, regexp: globToRegExp(pattern) }));
  } catch (error) {
    return {
      pattern: required[0].pattern,
      reason: `could not parse the pattern: ${error.message}`,
      action: 'correct the pattern and retry',
    };
  }

  const matched = matchingPaths(repoRoot, matchers);
  const missing = matchers.find((matcher) => !matched.has(matcher.pattern));
  return missing ? noMatchRefusal(missing.pattern) : null;
}
