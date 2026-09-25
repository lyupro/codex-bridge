/** Resolves the session host after the 2026-09-25 PATH host identity incident. */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { detectHostVersion } from './host-contract.mjs';
import { readHostObservations } from '../src/home/lib/host-observations.mjs';

export function resolveProbeTarget({ stateDir, executable, env = process.env, run = spawnSync, exists = fs.existsSync }) {
  if (executable) {
    const version = detectHostVersion({ run, executable });
    return version === null
      ? { error: `Could not read the version of ${executable}.` }
      : { executable, version, source: 'flag' };
  }

  const observations = readHostObservations({ stateDir });
  const newest = Object.entries(observations.hosts)
    .filter(([, entry]) => Number.isFinite(Date.parse(entry?.lastSeen)))
    .sort((a, b) => Date.parse(b[1].lastSeen) - Date.parse(a[1].lastSeen))[0];
  if (!newest) {
    return { error: 'No Claude Code session has been observed by this installation yet; run any shell command in a session first, or pass --probe-executable <path>.' };
  }
  const [version] = newest;
  const candidates = [];
  if (env.CLAUDE_CODE_EXECPATH && exists(env.CLAUDE_CODE_EXECPATH)) candidates.push(env.CLAUDE_CODE_EXECPATH);
  candidates.push('claude');
  const checked = [];
  for (const candidate of candidates) {
    const candidateVersion = detectHostVersion({ run, executable: candidate });
    checked.push(`${candidate} (${candidateVersion ?? 'unknown'})`);
    if (candidateVersion === version) return { executable: candidate, version, source: 'observed' };
  }
  return { error: `No executable of the observed host ${version} was found (checked: ${checked.join(', ')}); pass --probe-executable <path>.` };
}
