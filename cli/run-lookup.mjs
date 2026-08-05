/** Resolves a run argument and confirms that it names an existing run directory. */
import fs from 'node:fs';
import path from 'node:path';
import { git } from '../src/runner/git-state.mjs';
import { resolveProjectRunsDir } from '../src/runner/project-dir.mjs';
import { runsRoot } from '../src/runner/runs-root.mjs';

function projectRoot(cwd) {
  const result = git(cwd, ['rev-parse', '--show-toplevel']);
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : cwd;
}

function refusal(command, message) {
  return { runDir: null, error: `codex-bridge ${command}: ${message}` };
}

/**
 * Resolves the same bare-name lookup for every run command. Keeping the existence check here
 * prevents log from reading a path that stop would reject, and the command parameter keeps
 * malformed-input advice from naming the command the operator did not invoke.
 */
export function resolveRunFolder({
  command = 'stop',
  run,
  cwd = process.cwd(),
  runsRootPath = runsRoot(),
} = {}) {
  const commandName = String(command || 'stop');
  const value = String(run ?? '').trim();
  if (!value || value === '.' || value === '..') {
    return refusal(commandName, `${commandName} requires a run folder (full path or bare folder name)`);
  }

  let runDir;
  try {
    if (path.isAbsolute(value)) runDir = path.resolve(value);
    else {
      if (path.dirname(value) !== '.') {
        return refusal(commandName, 'a bare run folder name or a full path is required');
      }
      const projectRuns = resolveProjectRunsDir(runsRootPath, projectRoot(cwd), { create: false });
      runDir = path.join(projectRuns.dir, value);
    }
  } catch (err) {
    return refusal(commandName, err.message);
  }

  let isDirectory = false;
  try {
    isDirectory = fs.statSync(runDir).isDirectory();
  } catch {}
  if (!isDirectory) {
    return {
      runDir: null,
      error: `Run folder not found: ${runDir}. Pass a full path or a bare run folder name from the current project's runs directory.`,
    };
  }
  return { runDir, error: null };
}
