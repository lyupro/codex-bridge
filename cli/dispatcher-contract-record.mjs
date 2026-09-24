/**
 * Keeps the latest conclusive verdict per dispatcher host contract, each bound to the host version it was
 * measured on. Its own file rather than a field of .host-contract.json (Plan_62 D14, D19): the refusal
 * record is replaced whole by its writer, and an inconclusive probe must never erase an earlier verdict.
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
    if (!record || typeof record !== 'object' || Array.isArray(record)
      || !record.contracts || typeof record.contracts !== 'object' || Array.isArray(record.contracts)) return { corrupt: true };
    return record;
  } catch { return { corrupt: true }; }
}

export function writeDispatcherContract({ stateDir, version, verdicts, now = new Date() }) {
  const file = path.join(stateDir, DISPATCHER_CONTRACT_FILE);
  const previous = readDispatcherContract({ stateDir });
  if (previous?.corrupt) throw new Error(`Cannot update corrupt dispatcher contract: ${file}`);
  const contracts = { ...(previous?.contracts ?? {}) };
  for (const name of DISPATCHER_CONTRACTS) {
    const result = verdicts?.[name]?.result;
    if (result === 'honored' || result === 'changed') {
      contracts[name] = { result, version, checkedAt: new Date(now).toISOString(), detail: verdicts[name].detail };
    }
  }
  const record = { contracts };
  writeJsonAtomic(file, record);
  return record;
}
