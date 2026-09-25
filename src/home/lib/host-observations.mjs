/** Records session host versions after the 2026-09-25 PATH host identity incident. */
import fs from 'node:fs';
import path from 'node:path';
import { writeHomeJsonAtomic } from './atomic-json.mjs';
import { withHomeFileLock } from './file-lock.mjs';
import { stateDirWriter } from './home-write.mjs';
import { parseJsonText } from './json-file.mjs';
import { transcriptHostVersion } from './host-version.mjs';

export const HOST_OBSERVATIONS_FILE = 'host-observations.json';

export function readHostObservations({ stateDir }) {
  const file = path.join(stateDir, HOST_OBSERVATIONS_FILE);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { hosts: {}, sessions: {} };
    return { hosts: {}, sessions: {}, corrupt: true };
  }
  try {
    const record = parseJsonText(file, raw);
    if (!record || typeof record !== 'object' || Array.isArray(record)
      || !record.hosts || typeof record.hosts !== 'object' || Array.isArray(record.hosts)
      || !record.sessions || typeof record.sessions !== 'object' || Array.isArray(record.sessions)) {
      return { hosts: {}, sessions: {}, corrupt: true };
    }
    return { hosts: record.hosts, sessions: record.sessions };
  } catch {
    return { hosts: {}, sessions: {}, corrupt: true };
  }
}

export async function observeSessionHost({
  stateDir, sessionId, transcriptPath, now = new Date(), readVersion = transcriptHostVersion,
}) {
  const file = path.join(stateDir, HOST_OBSERVATIONS_FILE);
  if (readHostObservations({ stateDir }).sessions[sessionId]) return { recorded: false };
  const version = await readVersion(transcriptPath);
  if (version === null) return { recorded: false };
  // Plan_65 B6: the observations, their lock and temporaries are the registered host-observations artifact.
  const writer = stateDirWriter(stateDir);
  return withHomeFileLock(writer, 'host-observations', `${file}.lock`, async () => {
    const current = readHostObservations({ stateDir });
    if (current.corrupt) throw new Error(`Cannot update corrupt host observations: ${file}`);
    if (current.sessions[sessionId]) return { recorded: false };
    const at = new Date(now).toISOString();
    const cutoffSessions = Date.parse(at) - 7 * 24 * 60 * 60 * 1000;
    const cutoffHosts = Date.parse(at) - 30 * 24 * 60 * 60 * 1000;
    const sessions = Object.fromEntries(Object.entries(current.sessions)
      .filter(([, entry]) => Date.parse(entry.at) >= cutoffSessions));
    const hosts = Object.fromEntries(Object.entries(current.hosts)
      .filter(([, entry]) => Date.parse(entry.lastSeen) >= cutoffHosts));
    sessions[sessionId] = { version, at };
    const existing = hosts[version];
    hosts[version] = { firstSeen: existing?.firstSeen || at, lastSeen: at };
    writeHomeJsonAtomic(writer, 'host-observations', file, { hosts, sessions });
    return { recorded: true };
  }, { description: 'host observations' });
}
