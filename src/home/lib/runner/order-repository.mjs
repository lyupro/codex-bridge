/** Owns the choice of an order's target repository under OW-073 after shell cwd chose the target in the incident. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizeRepoPath } from './project-dir.mjs';
import { orderRuleMessage } from '../order-rules.mjs';

/**
 * OW-061: outside git the launcher keeps `repository:` as given and the project folder takes its
 * last segment, so a dispatcher that folded its own instructions into the value left run folders
 * named `Obsidian. Run the scope phase. Return ≤5 lines and the run folder path.` and
 * `tradeforge.loc (do not cd into codex-runs).` — names with a trailing dot that Windows cannot
 * open through an ordinary path. Only an existing absolute directory whose segments Windows keeps
 * verbatim may name the repository.
 */
export function repositoryRefusal(value) {
  if (!path.isAbsolute(value)) {
    return orderRuleMessage('repository-path', { violation: 'relative', value });
  }
  const altered = value.split(/[\\/]/).find((segment) => /[. ]$/.test(segment) && segment !== '.' && segment !== '..');
  if (altered !== undefined) {
    return orderRuleMessage('repository-path', { violation: 'altered-segment', value, segment: altered });
  }
  let isDirectory = false;
  try {
    isDirectory = fs.statSync(value).isDirectory();
  } catch {}
  return isDirectory ? null : orderRuleMessage('repository-path', { violation: 'not-directory', value });
}

const firstLine = (text) => String(text || '').trim().split(/\r?\n/, 1)[0];
const discoveryFailure = (error) => ({
  ok: false,
  violation: 'repository-discovery-failed',
  values: { error: firstLine(error) },
});

export function discoverGitRoot(dir) {
  // OW-073: inherited Git overrides must not redirect discovery into another tree.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')),
  );
  let result;
  try {
    result = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      windowsHide: true,
      env,
    });
  } catch (error) {
    return { error: firstLine(error.message) };
  }

  const stderr = firstLine(result.stderr);
  if (result.error) return { error: stderr || firstLine(result.error.message) };
  if (result.status === 0) {
    const root = result.stdout.trim();
    return root ? { root: path.resolve(root) } : { error: 'git returned an empty working-tree root' };
  }
  if (result.status !== null && /not a git repository/i.test(result.stderr || '')) {
    return { outside: true };
  }
  return { error: stderr || `git rev-parse failed (status ${result.status}, signal ${result.signal})` };
}

export function resolveOrderRepository({ taskFile, label, gitRoot = discoverGitRoot }) {
  const hasLabel = label !== undefined;
  if (hasLabel) {
    try {
      if (typeof label !== 'string' || !path.isAbsolute(label) || !fs.statSync(label).isDirectory()) {
        return { ok: false, violation: 'repository-label-invalid', values: { label } };
      }
    } catch {
      return { ok: false, violation: 'repository-label-invalid', values: { label } };
    }
  }

  let taskFileRoot;
  if (taskFile !== null) {
    try {
      // Use the JS realpath implementation: native adds Windows device/UNC prefixes.
      const realTaskFile = fs.realpathSync(taskFile);
      const found = gitRoot(path.dirname(realTaskFile));
      if (found.error !== undefined) return discoveryFailure(found.error);
      if (found.root) taskFileRoot = path.resolve(found.root);
    } catch (error) {
      return discoveryFailure(error.message);
    }
  }

  if (!hasLabel) {
    return taskFileRoot
      ? { ok: true, repo: taskFileRoot, source: 'task-file' }
      : { ok: false, violation: 'repository-label-required', values: { taskFile: taskFile ?? 'stdin' } };
  }

  let labelRoot;
  try {
    const found = gitRoot(label);
    if (found.error !== undefined) return discoveryFailure(found.error);
    if (found.root) labelRoot = path.resolve(found.root);
  } catch (error) {
    return discoveryFailure(error.message);
  }

  const labelRepo = labelRoot || path.resolve(label);
  if (taskFileRoot) {
    if (!labelRoot || normalizeRepoPath(taskFileRoot) !== normalizeRepoPath(labelRoot)) {
      return {
        ok: false,
        violation: 'repository-mismatch',
        values: { taskFileRoot, labelRepo },
      };
    }
    return { ok: true, repo: taskFileRoot, source: 'task-file+label' };
  }
  return { ok: true, repo: labelRepo, source: 'label' };
}
