/**
 * Reads the activity of one Codex thread from its session log.
 * Plan_80 S1/S2: stdout goes silent before the session log, and the silence threshold
 * was calibrated on session-log record times. Codex owns the format, so an unknown
 * shape must be reported, never interpreted as silence.
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveCodexHome } from './codex-home.mjs';
import { parseJsonText } from './json-file.mjs';

const KNOWN_TYPES = new Set([
  'session_meta', 'event_msg', 'response_item', 'turn_context', 'world_state', 'token_usage_record',
]);
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Read only the start day's local folder and its two neighbors; never scan the store. */
function findRollout(codexHome, threadId, start) {
  for (const offset of [0, -1, 1]) {
    const day = new Date(start);
    day.setDate(day.getDate() + offset);
    const folder = path.join(codexHome, 'sessions', String(day.getFullYear()),
      String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
    let names;
    try {
      names = fs.readdirSync(folder);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const name = names.sort().find((entry) =>
      /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-/.test(entry) &&
      entry.endsWith(`-${threadId}.jsonl`));
    if (name) return { file: name, fullPath: path.join(folder, name) };
  }
  return null;
}

/** Returns structural activity evidence only; payload text never leaves this reader. */
export function readSessionActivity({ threadId, startedAt, codexHome = resolveCodexHome(), now = () => new Date() }) {
  const result = {
    state: 'not-observed', reason: null, file: null, last_record_at: null,
    last_record_kind: null, records: 0, unknown_kinds: [], sampled_at: now().toISOString(),
  };
  if (!threadId) return result;
  // A state, not a throw: the worker builds the stop record before collect(), and a reader that
  // threw there would fail a finished run over evidence the verdict never reads. Guessing today's
  // folder instead would read the wrong day as "missing".
  const start = new Date(startedAt);
  if (startedAt == null || !Number.isFinite(start.getTime())) {
    return { ...result, reason: 'run start time unknown' };
  }
  let source;
  try {
    const found = findRollout(codexHome, threadId, start);
    if (!found) return { ...result, state: 'missing' };
    result.file = found.file;
    source = fs.readFileSync(found.fullPath, 'utf8');
  } catch (error) {
    return { ...result, state: 'unreadable', reason: error.message };
  }
  if (source === '') return { ...result, state: 'empty' };
  const terminated = source.endsWith('\n');
  const lines = source.split('\n');
  if (terminated) lines.pop();
  let sawSessionMeta = false;
  const invalid = (rule, line) => ({
    ...result, state: 'unrecognized', reason: `${rule} at line ${line}`,
    last_record_at: null, last_record_kind: null,
  });
  for (let index = 0; index < lines.length; index += 1) {
    const line = index + 1;
    if (lines[index].endsWith('\r')) return invalid('LF-only line ending required', line);
    // parseJsonText strips a BOM for files other programs write; this format has none, so a
    // BOM is a format change to report rather than to absorb.
    if (lines[index].charCodeAt(0) === 0xfeff) return invalid('BOM not allowed', line);
    let record;
    try {
      record = parseJsonText(result.file, lines[index]);
    } catch {
      if (index === lines.length - 1) return { ...result, state: 'incomplete' };
      return invalid('JSON record required', line);
    }
    if (!object(record) || typeof record.timestamp !== 'string' ||
        typeof record.ordinal !== 'number' || !Number.isFinite(record.ordinal) ||
        typeof record.type !== 'string' || !object(record.payload)) {
      return invalid('Envelope requires timestamp, numeric ordinal, type and object payload', line);
    }
    if (!TIMESTAMP.test(record.timestamp) || !Number.isFinite(Date.parse(record.timestamp)) ||
        new Date(record.timestamp).toISOString() !== record.timestamp) {
      return invalid('Timestamp must use YYYY-MM-DDTHH:mm:ss.sssZ', line);
    }
    if (record.type === 'session_meta' && !sawSessionMeta) {
      if (record.payload.id !== threadId) return invalid('First session_meta id must match thread id', line);
      sawSessionMeta = true;
    }
    if (!KNOWN_TYPES.has(record.type) && !result.unknown_kinds.includes(record.type)) {
      result.unknown_kinds.push(record.type);
    }
    result.records += 1;
    result.last_record_at = record.timestamp;
    result.last_record_kind = ['event_msg', 'response_item'].includes(record.type) &&
      typeof record.payload.type === 'string' ? `${record.type}/${record.payload.type}` : record.type;
  }
  return { ...result, state: terminated ? 'observed' : 'incomplete' };
}
