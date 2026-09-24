/** Records the 2026-09-17..24 silent SubagentHandback contract break before it can go unnoticed again. */
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './atomic-json.mjs';
import { parseJsonText } from './json-file.mjs';
import { withFileLock } from './file-lock.mjs';

const WITNESS_FILE = 'handback-witness.json';

export function hostSdkVersion(env = process.env) {
  const version = env.CLAUDE_AGENT_SDK_VERSION;
  if (typeof version !== 'string') return null;
  return version.trim() || null;
}

function isWitness(record) {
  const witnessEntry = (entry, alarm = false) => entry && typeof entry === 'object'
    && !Array.isArray(entry)
    && (entry.sdkVersion === null || typeof entry.sdkVersion === 'string')
    && typeof entry.at === 'string'
    && (!alarm || typeof entry.detail === 'string');
  return record && typeof record === 'object' && !Array.isArray(record)
    && (record.lastSeen === null || witnessEntry(record.lastSeen))
    && Array.isArray(record.alarms) && record.alarms.every((entry) => witnessEntry(entry, true));
}

export function readHandbackWitness({ stateDir }) {
  const file = path.join(stateDir, WITNESS_FILE);
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { lastSeen: null, alarms: [] };
    return { corrupt: true };
  }
  try {
    const record = parseJsonText(file, source);
    return isWitness(record) ? record : { corrupt: true };
  } catch {
    return { corrupt: true };
  }
}

function timestamp(now) {
  return new Date(now).toISOString();
}


export async function recordHandbackWitness({ stateDir, kind, sdkVersion, detail = '', now = new Date() }) {
  if (kind !== 'seen' && kind !== 'alarm') throw new TypeError("kind must be 'seen' or 'alarm'");
  if (sdkVersion !== null && typeof sdkVersion !== 'string') {
    throw new TypeError('sdkVersion must be a string or null');
  }
  const file = path.join(stateDir, WITNESS_FILE);
  return withFileLock(`${file}.lock`, async () => {
    const current = readHandbackWitness({ stateDir });
    if (current.corrupt) throw new Error(`Cannot update corrupt handback witness: ${file}`);
    const at = timestamp(now);
    const record = kind === 'seen'
      ? { ...current, lastSeen: { sdkVersion, at } }
      : { ...current, alarms: [...current.alarms, { sdkVersion, at, detail }].slice(-20) };
    writeJsonAtomic(file, record);
    return record;
  }, { description: 'handback witness' });
}
