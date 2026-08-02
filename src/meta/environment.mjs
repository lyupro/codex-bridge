/**
 * Tells apart what a run changed from what the tooling around it changed.
 *
 * Every verdict about a build run rests on the worktree either side of it, and that
 * comparison assumes the run is the only writer. In a repository under OMC and Claude Code it
 * never is: on 2026-08-02 a run that touched exactly its three scoped files was failed for
 * “out-of-scope changes: .omc/project-memory.json”, written by the orchestrator's own tooling
 * while Codex worked.
 *
 * The patterns are read from the run's own env.json, not from the config, so recomputing an
 * old run's verdict gives the answer it gave then — the config may have changed since.
 */
import path from 'node:path';
import { globToRegExp, normalizePath, readJson } from './paths.mjs';

/** Empty for runs made before the list existed: absence means "the run was the only writer". */
export function environmentPatterns(runDir) {
  const configured = readJson(path.join(runDir, 'env.json'))?.environmentPaths;
  return Array.isArray(configured) ? configured.map((row) => String(row).trim()).filter(Boolean) : [];
}

/** Touched paths, normalized and sorted into the run's own work and the environment's. */
export function splitEnvironment(paths, patterns) {
  const matchers = (patterns || []).filter(Boolean).map(globToRegExp);
  const work = [];
  const environment = [];
  for (const raw of paths || []) {
    const file = normalizePath(raw);
    if (!file) continue;
    (matchers.some((re) => re.test(file)) ? environment : work).push(file);
  }
  return { work, environment };
}

/** The same split for a run on disk, using the patterns that were in force when it started. */
export const splitRunChanges = (runDir, paths) => splitEnvironment(paths, environmentPatterns(runDir));
