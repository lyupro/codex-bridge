/**
 * Commits a finished run's folder when the run store is a git repository of its own.
 *
 * Plan_77 D1/D5: on 2026-10-07 thousands of uncommitted runs in ~/.claude made a
 * VaultForge journal compile cost $16.57 instead of $0.3-0.8. Commit only in the
 * store's own repository, preserve the operator's staged paths, and never remove index.lock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveBrandHome } from '../brand-home.mjs';
import { readJsonFileSync } from '../json-file.mjs';
import { normalizeRepoPath, PROJECT_MARKER } from './project-dir.mjs';

function runGit(cwd, args) {
  return spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 120_000,
  });
}

function waitSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

const QUIET_REASONS = new Set(['not in git', 'repository is not the run store', 'nothing to commit']);

export function commitRunRecord(options) {
  let runDir;
  try {
    let brandRoot, git, sleep, attempts, waitMs;
    ({ runDir, brandRoot = resolveBrandHome().root, git = runGit,
      sleep = waitSync, attempts = 10, waitMs = 500 } = options);
    const storeRoot = path.dirname(path.dirname(runDir));
    const step = (cwd, args) => {
      for (let attempt = 1; ; attempt += 1) {
        let result;
        try {
          result = git(cwd, args);
        } catch (error) {
          result = { status: null, stderr: error.message, error };
        }
        const locked = String(result.stderr).includes('index.lock');
        if (locked && attempt < attempts) {
          sleep(waitMs);
          continue;
        }
        return { ...result, locked };
      }
    };
    const failure = (name, result) => {
      const firstLine = String(result.stderr || result.error?.message || '').trim().split(/\r?\n/)[0];
      return { committed: false,
        reason: `git ${name} failed (exit ${result.status ?? 'unknown'}): ${firstLine}` };
    };
    const perform = () => {
      const repo = step(storeRoot, ['rev-parse', '--show-toplevel']);
      if (repo.locked || repo.status !== 0) {
        return !repo.locked && /not a git repository/i.test(repo.stderr || '')
          ? { committed: false, reason: 'not in git' } : failure('rev-parse', repo);
      }
      const top = repo.stdout.trim();
      const normalizedTop = normalizeRepoPath(top);
      const normalizedStore = normalizeRepoPath(storeRoot);
      const normalizedBrand = normalizeRepoPath(brandRoot);
      if (normalizedTop !== normalizedStore && !(normalizedTop === normalizedBrand &&
          normalizedStore.startsWith(`${normalizedBrand}/`))) {
        return { committed: false, reason: 'repository is not the run store' };
      }

      const relative = (file) => path.relative(top, file).replaceAll(path.sep, '/');
      const paths = [relative(runDir)];
      const marker = path.join(path.dirname(runDir), PROJECT_MARKER);
      if (fs.existsSync(marker)) paths.push(relative(marker));
      const added = step(top, ['add', '-A', '--', ...paths]);
      if (added.locked || added.status !== 0) return failure('add', added);
      const diff = step(top, ['diff', '--cached', '--quiet', '--', ...paths]);
      if (diff.locked) return failure('diff', diff);
      if (diff.status === 0) return { committed: false, reason: 'nothing to commit' };
      if (diff.status !== 1) return failure('diff', diff);

      let status = 'unknown';
      try {
        status = readJsonFileSync(path.join(runDir, 'meta.json'))?.status ?? 'unknown';
      } catch {
        // An unreadable verdict must not prevent preserving the finished record (Plan_77 B6).
      }
      const message = `${path.basename(path.dirname(runDir))}/${path.basename(runDir)}: ${status}`;
      // D5: the pathspec keeps every unrelated staged entry out of this commit and in the index.
      const committed = step(top, ['commit', '--quiet', '-m', message, '--', ...paths]);
      return !committed.locked && committed.status === 0
        ? { committed: true, reason: 'committed' } : failure('commit', committed);
    };
    const result = perform();
    if (!result.committed && !QUIET_REASONS.has(result.reason)) appendFailure(runDir, result.reason);
    return result;
  } catch (error) {
    const reason = `autocommit failed: ${String(error?.message || error).split(/\r?\n/)[0]}`;
    appendFailure(runDir, reason);
    return { committed: false, reason };
  }
}

function appendFailure(runDir, reason) {
  try {
    fs.appendFileSync(path.join(runDir, 'stderr.log'), `autocommit: ${reason}\n`);
  } catch {
    // Even an unwritable diagnostic log cannot change the run's verdict (Plan_77 B6).
  }
}
