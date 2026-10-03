/**
 * Judges added lines against start bytes because Plan_60 D3a must not blame earlier dirty work or TODO test data.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFlagBaseline, removeFlagBaselineCopies, FLAG_BASELINE_DIR } from './flag-baseline.mjs';
import { runSnapshotChanges } from '../meta/run-snapshots.mjs';

const STUB = /test\.(skip|only)|it\.(skip|only)|describe\.(skip|only)|NotImplemented/;
const MARKER_PREFIX = /(?:^[ \t]*|\/\/[ \t]*|\/\*+[ \t]*|#[ \t]*|<!--[ \t]*|--[ \t]*|^[ \t]*\*[ \t]*)$/;
const LIST_PREFIX = /^[ \t]*(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?$/;

export function isFlagLine(text) {
  if (STUB.test(text)) return true;
  for (const match of text.matchAll(/(?:TODO|FIXME)(?![A-Za-z0-9_])/g)) {
    const prefix = text.slice(0, match.index);
    if (MARKER_PREFIX.test(prefix) || LIST_PREFIX.test(prefix)) return true;
  }
  return false;
}

function addedLines(diff) {
  const added = [];
  let inside = false;
  let number = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff ')) {
      inside = false;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      inside = true;
      number = Number(hunk[1]);
    } else if (inside && line.startsWith('+')) {
      added.push({ number, text: line.slice(1) });
      number += 1;
    } else if (inside && line.startsWith(' ')) {
      number += 1;
    }
  }
  return added;
}

function compareFile(baseFile, currentFile) {
  const result = spawnSync('git', [
    '-c', 'core.quotepath=false', 'diff', '--no-index', '--no-color', '--no-ext-diff', '--no-textconv',
    '--ignore-cr-at-eol', '--diff-algorithm=myers', '-U0', '--', baseFile, currentFile,
  ], { windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || ![0, 1].includes(result.status)) return null;
  return result.status === 0 ? [] : addedLines(result.stdout.toString('utf8'));
}

// `git show <head>:<path>` exits non-zero both for a path the start commit lacks (a new file: every line is added)
// and for a start commit nobody can read; only a readable commit lets the first case accuse anyone.
function headReadable(repoRoot, head) {
  const result = spawnSync('git', ['-C', repoRoot, 'cat-file', '-e', `${head}^{commit}`], {
    windowsHide: true, timeout: 30_000,
  });
  return !result.error && result.status === 0;
}

function scanPath({ name, entry, baseline, headKnown, runDir, repoRoot, gaps }) {
  const currentFile = path.join(repoRoot, name);
  let current;
  try {
    const stat = fs.lstatSync(currentFile);
    if (!stat.isFile()) return [];
    if (stat.size > baseline.limits.perFileBytes) {
      gaps.push(`${name}: end content over the limit`);
      return [];
    }
    current = fs.readFileSync(currentFile);
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') gaps.push(`${name}: end content unreadable`);
    return [];
  }
  if (current.length > baseline.limits.perFileBytes) {
    gaps.push(`${name}: end content over the limit`);
    return [];
  }
  if (current.subarray(0, 8000).includes(0)) return [];

  let base = Buffer.alloc(0);
  let baseFile;
  let temporary = false;
  if (entry) {
    if (entry.state === 'copied') {
      baseFile = path.join(runDir, FLAG_BASELINE_DIR, entry.copy);
      try {
        base = fs.readFileSync(baseFile);
      } catch {
        gaps.push(`${name}: start content unreadable`);
        return [];
      }
    } else if (!['deleted', 'absent'].includes(entry.state)) {
      gaps.push(`${name}: start content ${entry.state}`);
      return [];
    }
  } else if (!headKnown) {
    gaps.push(`${name}: start commit unreadable`);
    return [];
  } else {
    const result = spawnSync('git', ['-C', repoRoot, 'show', `${baseline.head}:${name}`], {
      windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
    });
    if (result.error || result.status === null) {
      gaps.push(`${name}: start content unreadable`);
      return [];
    }
    if (result.status === 0) base = result.stdout;
    if (base.length) {
      const copyDir = path.join(runDir, FLAG_BASELINE_DIR);
      fs.mkdirSync(copyDir, { recursive: true });
      baseFile = path.join(copyDir, `head-${randomUUID()}.bin`);
      fs.writeFileSync(baseFile, base, { flag: 'wx' });
      temporary = true;
    }
  }

  if (!base.length) {
    return current.toString('utf8').split('\n').map((text, index) => ({ number: index + 1, text }));
  }
  let added;
  try {
    added = compareFile(baseFile, currentFile);
  } finally {
    if (temporary) fs.unlinkSync(baseFile);
  }
  if (added === null) {
    gaps.push(`${name}: diff failed`);
    return [];
  }
  return added;
}

export function scanRunFlags({ runDir, repoRoot }) {
  const gaps = [];
  const hits = [];
  try {
    const baseline = readFlagBaseline(runDir);
    if (!baseline) {
      gaps.push('no flag baseline');
    } else if (!baseline.complete && baseline.files.length === 0) {
      gaps.push(`flag baseline incomplete: ${baseline.reason}`);
    } else {
      const entries = new Map(baseline.files.map((entry) => [entry.path, entry]));
      const comparison = runSnapshotChanges(runDir);
      if (!comparison.ok) gaps.push('snapshots not comparable');
      const names = [...new Set([...entries.keys(), ...(comparison.ok ? comparison.changed : [])])].sort();
      const headKnown = headReadable(repoRoot, baseline.head);
      for (const name of names) {
        const added = scanPath({ name, entry: entries.get(name), baseline, headKnown, runDir, repoRoot, gaps });
        for (const line of added) {
          if (hits.length < 20 && isFlagLine(line.text)) hits.push(`${name}:${line.number}: ${line.text.trim()}\n`);
        }
      }
    }
  } finally {
    removeFlagBaselineCopies(runDir);
  }
  return { text: hits.join(''), coverage: { complete: gaps.length === 0, gaps } };
}
