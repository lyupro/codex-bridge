/**
 * Keeps the latest conclusive verdict per dispatcher host contract, per host version: on 2026-09-25 the
 * VS Code host 2.1.282 ran beside the CLI host 2.1.281, and probing either must keep the other's verdict.
 * Its own file rather than a field of .host-contract.json (Plan_62 D14, D19), and an inconclusive probe
 * must never erase an earlier verdict.
 */
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../src/home/lib/atomic-json.mjs';
import { parseJsonText } from '../src/home/lib/json-file.mjs';
import { DISPATCHER_CONTRACTS } from './dispatcher-contract.mjs';

export const DISPATCHER_CONTRACT_FILE = 'dispatcher-contract.json';

export function readDispatcherContract({ stateDir }) {
  const file = path.join(stateDir, DISPATCHER_CONTRACT_FILE);
  let source;
  try { source = fs.readFileSync(file, 'utf8'); } catch (error) {
    return error.code === 'ENOENT' ? null : { corrupt: true };
  }
  try {
    const record = parseJsonText(file, source);
    if (!record || typeof record !== 'object' || Array.isArray(record)) return { corrupt: true };
    if (record.hosts && typeof record.hosts === 'object' && !Array.isArray(record.hosts)) return record;
    if (!record.contracts || typeof record.contracts !== 'object' || Array.isArray(record.contracts)) return { corrupt: true };
    const hosts = {};
    for (const [name, item] of Object.entries(record.contracts)) {
      if (!item || typeof item.version !== 'string' || !item.version) continue;
      hosts[item.version] ??= { contracts: {} };
      const { version: _version, ...entry } = item;
      hosts[item.version].contracts[name] = entry;
    }
    return { hosts };
  } catch { return { corrupt: true }; }
}

export function writeDispatcherContract({ stateDir, version, verdicts, now = new Date() }) {
  const file = path.join(stateDir, DISPATCHER_CONTRACT_FILE);
  const previous = readDispatcherContract({ stateDir });
  if (previous?.corrupt) throw new Error(`Cannot update corrupt dispatcher contract: ${file}`);
  const contracts = { ...(previous?.hosts?.[version]?.contracts ?? {}) };
  for (const name of DISPATCHER_CONTRACTS) {
    const result = verdicts?.[name]?.result;
    if (result === 'honored' || result === 'changed') {
      contracts[name] = { result, checkedAt: new Date(now).toISOString(), detail: verdicts[name].detail };
    }
  }
  const record = { hosts: { ...(previous?.hosts ?? {}), [version]: { contracts } } };
  writeJsonAtomic(file, record);
  return record;
}
