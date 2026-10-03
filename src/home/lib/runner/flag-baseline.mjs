/**
 * Records dirty files' start bytes so Plan_60 D3a can distinguish this run's flags from earlier uncommitted work.
 */
import fs from 'node:fs';
import path from 'node:path';
import { headSha, runsPrefixInside } from './git-state.mjs';
import { diffNames, listUntrackedPaths } from './git-paths.mjs';
import { readJsonFileSync } from '../json-file.mjs';

export const FLAG_BASELINE_VERSION = 1;
export const FLAG_BASELINE_MANIFEST = 'flags-baseline.json';
export const FLAG_BASELINE_DIR = 'flags-baseline';
export const FLAG_BASELINE_LIMITS = Object.freeze({
  perFileBytes: 1024 * 1024,
  perRunBytes: 32 * 1024 * 1024,
});

export function captureFlagBaseline({ runDir, repoRoot, isGitRepo, limits = FLAG_BASELINE_LIMITS }) {
  const manifest = {
    version: FLAG_BASELINE_VERSION,
    head: '',
    complete: false,
    reason: '',
    limits: { ...limits },
    files: [],
  };
  if (!isGitRepo) {
    manifest.reason = 'not a git repository';
  } else {
    const head = headSha(repoRoot);
    // rev-parse prints the literal HEAD on an unborn branch; it is not a start commit.
    manifest.head = head === 'HEAD' ? '' : head;
    if (!manifest.head) {
      manifest.reason = 'no start commit';
    } else {
      const dirty = diffNames(repoRoot, 'HEAD');
      const untracked = listUntrackedPaths(repoRoot);
      if (dirty === null || untracked === null) {
        manifest.reason = 'git listing failed';
      } else {
        const tracked = new Set(dirty);
        const skip = runsPrefixInside(repoRoot);
        const names = [...new Set([...dirty, ...untracked])]
          .filter((name) => !(skip && `${name}/`.startsWith(skip)))
          .sort();
        let total = 0;
        for (const [index, name] of names.entries()) {
          const entry = { path: name, tracked: tracked.has(name), state: 'unreadable' };
          manifest.files.push(entry);
          const full = path.join(repoRoot, name);
          let content;
          try {
            const stat = fs.lstatSync(full);
            if (!stat.isFile()) continue;
            if (stat.size > limits.perFileBytes) {
              entry.state = 'truncated';
              continue;
            }
            if (total + stat.size > limits.perRunBytes) {
              entry.state = 'over-run-cap';
              continue;
            }
            content = fs.readFileSync(full);
          } catch (error) {
            if (error.code === 'ENOENT') entry.state = entry.tracked ? 'deleted' : 'absent';
            continue;
          }
          // Recheck actual bytes: the file may have grown since its metadata was read.
          if (content.length > limits.perFileBytes) {
            entry.state = 'truncated';
          } else if (total + content.length > limits.perRunBytes) {
            entry.state = 'over-run-cap';
          } else if (content.subarray(0, 8000).includes(0)) {
            entry.state = 'binary';
          } else {
            const copyDir = path.join(runDir, FLAG_BASELINE_DIR);
            fs.mkdirSync(copyDir, { recursive: true });
            const copy = `${index}.bin`;
            fs.writeFileSync(path.join(copyDir, copy), content);
            Object.assign(entry, { state: 'copied', copy, bytes: content.length });
            total += content.length;
          }
        }
        manifest.complete = manifest.files.every((entry) =>
          ['copied', 'deleted', 'absent'].includes(entry.state));
        if (!manifest.complete) manifest.reason = 'some start contents are unknown';
      }
    }
  }
  fs.writeFileSync(path.join(runDir, FLAG_BASELINE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function readFlagBaseline(runDir) {
  try {
    const manifest = readJsonFileSync(path.join(runDir, FLAG_BASELINE_MANIFEST));
    return manifest?.version === FLAG_BASELINE_VERSION ? manifest : null;
  } catch {
    return null;
  }
}

export function removeFlagBaselineCopies(runDir) {
  fs.rmSync(path.join(runDir, FLAG_BASELINE_DIR), { recursive: true, force: true });
}
