/** Records the 2026-09-17..24 handback break; 2026-09-25 proved SDK env is inherited, so identify hosts from transcripts. */
import fs from 'node:fs';
import path from 'node:path';
import { writeHomeJsonAtomic } from './atomic-json.mjs';
import { parseJsonText } from './json-file.mjs';
import { withHomeFileLock } from './file-lock.mjs';
import { stateDirWriter } from './home-write.mjs';
import { transcriptHostVersion } from './host-version.mjs';

export const WITNESS_FILE = 'handback-witness.json';

export async function witnessHostVersion(payload) {
  return transcriptHostVersion(payload?.transcript_path);
}

function normalizeWitness(record) {
  const alarmEntry = (entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
    && (entry.hostVersion === null || typeof entry.hostVersion === 'string')
    && typeof entry.at === 'string' && typeof entry.detail === 'string';
  if (!record || typeof record !== 'object' || Array.isArray(record) || !Array.isArray(record.alarms)) return null;
  if (record.alarms.every(alarmEntry) && record.lastSeen && typeof record.lastSeen === 'object'
    && !Array.isArray(record.lastSeen) && !Object.hasOwn(record.lastSeen, 'sdkVersion')
    && !Object.hasOwn(record.lastSeen, 'at') && Object.values(record.lastSeen).every((at) => typeof at === 'string')) return record;
  const legacy = record.lastSeen === null || (record.lastSeen && typeof record.lastSeen === 'object'
    && !Array.isArray(record.lastSeen) && typeof record.lastSeen.sdkVersion === 'string' && typeof record.lastSeen.at === 'string');
  const legacyAlarm = (entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
    && (entry.sdkVersion === null || typeof entry.sdkVersion === 'string') && typeof entry.at === 'string'
    && typeof entry.detail === 'string';
  if (legacy && record.alarms.every(legacyAlarm)) return { lastSeen: {}, alarms: record.alarms.map(({ at, detail }) => ({ hostVersion: null, at, detail })) };
  return null;
}

export function readHandbackWitness({ stateDir }) {
  const file = path.join(stateDir, WITNESS_FILE);
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { lastSeen: {}, alarms: [] };
    return { corrupt: true };
  }
  try {
    const record = parseJsonText(file, source);
    return normalizeWitness(record) || { corrupt: true };
  } catch {
    return { corrupt: true };
  }
}

function timestamp(now) {
  return new Date(now).toISOString();
}


export async function recordHandbackWitness({ stateDir, kind, hostVersion, detail = '', now = new Date() }) {
  if (kind !== 'seen' && kind !== 'alarm') throw new TypeError("kind must be 'seen' or 'alarm'");
  if (hostVersion !== null && typeof hostVersion !== 'string') {
    throw new TypeError('hostVersion must be a string or null');
  }
  const file = path.join(stateDir, WITNESS_FILE);
  // Plan_65 B6: the witness, its lock and temporaries are the registered handback-witness artifact.
  const writer = stateDirWriter(stateDir);
  return withHomeFileLock(writer, 'handback-witness', `${file}.lock`, async () => {
    const current = readHandbackWitness({ stateDir });
    if (current.corrupt) throw new Error(`Cannot update corrupt handback witness: ${file}`);
    const at = timestamp(now);
    const record = kind === 'seen'
      ? { ...current, lastSeen: hostVersion === null ? current.lastSeen : { ...current.lastSeen, [hostVersion]: at } }
      : { ...current, alarms: [...current.alarms, { hostVersion, at, detail }].slice(-20) };
    writeHomeJsonAtomic(writer, 'handback-witness', file, record);
    return record;
  }, { description: 'handback witness' });
}
