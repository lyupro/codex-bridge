/** Records the host's rules-core loading evidence (Plan_64 D11), without resolving owners or versions. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeHomeJsonAtomic } from './atomic-json.mjs';
import { withHomeFileLock } from './file-lock.mjs';
import { stateDirWriter } from './home-write.mjs';
import { parseJsonText } from './json-file.mjs';

export const LOAD_WITNESS_FILE = 'load-witness.json';
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const { readFileSync: readCoreBytes } = fs;

export function readLoadWitness({ stateDir }) {
  const file = path.join(stateDir, LOAD_WITNESS_FILE);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { sessions: {} };
    return { sessions: {}, corrupt: true };
  }
  try {
    const record = parseJsonText(file, raw);
    if (!record || typeof record !== 'object' || Array.isArray(record)
      || !record.sessions || typeof record.sessions !== 'object' || Array.isArray(record.sessions)) {
      return { sessions: {}, corrupt: true };
    }
    return { sessions: record.sessions };
  } catch {
    return { sessions: {}, corrupt: true };
  }
}

export function isCoreLoadCandidate(filePath) {
  return typeof filePath === 'string'
    && filePath.replaceAll('\\', '/').toLowerCase().endsWith('/rules/codex-bridge/core.md');
}

export async function recordCoreLoad({ stateDir, input, now = new Date(), readFile = readCoreBytes }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { recorded: false, reason: 'invalid-input' };
  }
  if (input.hook_event_name !== 'InstructionsLoaded') return { recorded: false, reason: 'other-event' };
  if (input.load_reason !== 'session_start') return { recorded: false, reason: 'other-load-reason' };
  if (typeof input.session_id !== 'string' || !input.session_id.trim()) {
    return { recorded: false, reason: 'missing-session-id' };
  }
  if (typeof input.file_path !== 'string' || !input.file_path.trim()) {
    return { recorded: false, reason: 'missing-file-path' };
  }
  if (!isCoreLoadCandidate(input.file_path)) return { recorded: false, reason: 'other-file' };

  let sha256 = null;
  let readError;
  try {
    sha256 = createHash('sha256').update(readFile(input.file_path)).digest('hex');
  } catch (error) {
    readError = error.code ?? null;
  }
  const file = path.join(stateDir, LOAD_WITNESS_FILE);
  const writer = stateDirWriter(stateDir);
  return withHomeFileLock(writer, 'load-witness', `${file}.lock`, async () => {
    const current = readLoadWitness({ stateDir });
    if (current.corrupt) throw new Error(`Cannot update corrupt load witness: ${file}`);
    const at = new Date(now).toISOString();
    const cutoff = Date.parse(at) - RETENTION_MS;
    // A hand-edited entry without a loads array is dropped, not allowed to throw: one bad row would
    // otherwise lose every later witness, and a lost witness reads as "not verified" forever (D11).
    const sessions = Object.fromEntries(Object.entries(current.sessions).filter(([, entry]) => {
      if (!Array.isArray(entry?.loads)) return false;
      const newest = Math.max(...entry.loads.map((load) => Date.parse(load?.at)));
      return newest >= cutoff;
    }));
    const session = Object.hasOwn(sessions, input.session_id)
      ? sessions[input.session_id] : { loads: [] };
    const duplicate = session.loads.some((load) => load.path === input.file_path);
    if (!duplicate) {
      session.loads.push({
        path: input.file_path, loadReason: input.load_reason, memoryType: input.memory_type ?? null,
        sha256, at, ...(readError !== undefined ? { readError } : {}),
      });
    }
    session.transcriptPath ??= input.transcript_path;
    session.cwd ??= input.cwd;
    // Defining the key preserves host-provided session ids such as __proto__ as ordinary data.
    Object.defineProperty(sessions, input.session_id, { value: session, enumerable: true, configurable: true, writable: true });
    writeHomeJsonAtomic(writer, 'load-witness', file, { sessions });
    return duplicate ? { recorded: false, reason: 'duplicate-path' } : { recorded: true };
  }, { description: 'load witness' });
}
