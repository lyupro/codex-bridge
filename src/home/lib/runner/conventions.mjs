/** Renders the host and repository conventions that a run must carry in its task artifact. */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_PATH } from '../run-config.mjs';

const HOST_FILE = path.join(path.dirname(CONFIG_PATH), 'conventions.md');
const REPOSITORY_FILE = '.codex-conventions.md';

function readOptional(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Reads both convention layers at the point of use. Plan_13 showed that a reference to a required
 * file is not enforcement: the task must contain the bytes the run was given.
 *
 * A layer that is present but blank is dropped rather than rendered as an empty heading, for the
 * same reason doctor warns about it — an empty rules file looks like a working mechanism and is
 * not one, and in the artifact it would look like rules that were given and ignored.
 *
 * Duplication is impossible by construction and deliberately not guarded against: `sections`
 * starts empty on every launch and task.md is written into a folder that is never reused, so
 * there is nothing to append to. A guard reading the operator's task text for this heading would
 * only find the word in a task that talks ABOUT conventions, and silently drop the section from
 * the one run that most obviously needed it.
 */
export function renderConventions(repoRoot, hostFile = HOST_FILE) {
  const layers = [];
  const host = readOptional(hostFile);
  if (host?.trim()) layers.push(`### Host conventions\n\n${host}`);
  const repository = readOptional(path.join(repoRoot, REPOSITORY_FILE));
  if (repository?.trim()) layers.push(`### Repository conventions\n\n${repository}`);
  return layers.length ? `## Conventions\n\n${layers.join('\n\n')}` : '';
}
