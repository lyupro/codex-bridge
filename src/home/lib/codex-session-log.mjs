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

/** Plan_80 E12: pair structural tool records without retaining command input or output. */
function commandEvidence() {
  const pending = new Map();
  const called = new Set();
  let reason = null;
  return {
    get open() { return pending.size > 0; },
    accept(record) {
      if (record.type !== 'response_item') return;
      const { type, call_id: callId, name } = record.payload;
      const call = type === 'custom_tool_call' || type === 'function_call';
      const output = type === 'custom_tool_call_output' || type === 'function_call_output';
      if (!call && !output) return;
      if (typeof callId !== 'string') {
        reason ??= 'tool record missing string call_id';
        return;
      }
      if (call) {
        called.add(callId);
        pending.set(callId, { call_id: callId, name, called_at: record.timestamp });
        if (name === 'wait') reason ??= 'asynchronous command lifecycle';
      } else {
        if (!called.has(callId)) reason ??= 'orphan tool output';
        pending.delete(callId);
      }
    },
    snapshot(state) {
      const unsupported = [...pending.values()].find((call) => call.name !== 'exec');
      const unknown = state !== 'observed' ? `session ${state}` : reason ??
        (unsupported ? `open tool ${typeof unsupported.name === 'string' ? unsupported.name : 'unknown'}` : null);
      if (unknown) return { state: 'unknown', reason: unknown, pending: [] };
      return { state: pending.size ? 'in-flight' : 'none', reason: null, pending: [...pending.values()] };
    },
  };
}

const validTime = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));

/** Compute silence solely from the reader's reference snapshot, never transport receipts. */
export function silenceAgeMs(atReference, referenceAt) {
  if (!validTime(referenceAt)) return { ms: null, reason: 'reference time invalid' };
  const evidenceReason = atReference?.commands?.reason;
  if (typeof evidenceReason === 'string' && evidenceReason.startsWith('session ')) {
    return { ms: null, reason: `session evidence ${evidenceReason.slice('session '.length)}` };
  }
  if (!validTime(atReference?.last_record_at)) {
    return { ms: null, reason: 'no session record before reference' };
  }
  const ms = Date.parse(referenceAt) - Date.parse(atReference.last_record_at);
  return ms >= 0 ? { ms, reason: null } : { ms: null, reason: 'no session record before reference' };
}

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
export function readSessionActivity({ threadId, startedAt, referenceAt, codexHome = resolveCodexHome(), now = () => new Date() }) {
  const result = {
    state: 'not-observed', reason: null, file: null, last_record_at: null,
    last_record_kind: null, records: 0, unknown_kinds: [], sampled_at: now().toISOString(),
    longest_gap_ms: null, longest_quiet_gap_ms: null, at_reference: null,
  };
  const wholeCommands = commandEvidence();
  const referenceCommands = commandEvidence();
  const referenceValid = validTime(referenceAt);
  const reference = {
    as_of: referenceValid ? referenceAt : null, last_record_at: null,
    last_record_kind: null, records: 0, commands: null,
  };
  let quietGap = null;
  const finish = (overrides = {}) => {
    Object.assign(result, overrides);
    if (wholeCommands.snapshot(result.state).state !== 'unknown') result.longest_quiet_gap_ms = quietGap;
    if (referenceAt !== undefined) {
      reference.commands = referenceValid ? referenceCommands.snapshot(result.state) :
        { state: 'unknown', reason: 'reference time invalid', pending: [] };
      result.at_reference = reference;
    }
    return result;
  };
  if (!threadId) return finish();
  // A state, not a throw: the worker builds the stop record before collect(), and a reader that
  // threw there would fail a finished run over evidence the verdict never reads. Guessing today's
  // folder instead would read the wrong day as "missing".
  const start = new Date(startedAt);
  if (startedAt == null || !Number.isFinite(start.getTime())) {
    return finish({ reason: 'run start time unknown' });
  }
  let source;
  try {
    const found = findRollout(codexHome, threadId, start);
    if (!found) return finish({ state: 'missing' });
    result.file = found.file;
    source = fs.readFileSync(found.fullPath, 'utf8');
  } catch (error) {
    return finish({ state: 'unreadable', reason: error.message });
  }
  if (source === '') return finish({ state: 'empty' });
  const terminated = source.endsWith('\n');
  const lines = source.split('\n');
  if (terminated) lines.pop();
  let sawSessionMeta = false;
  const invalid = (rule, line) => finish({
    state: 'unrecognized', reason: `${rule} at line ${line}`,
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
      if (index === lines.length - 1) return finish({ state: 'incomplete' });
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
    if (result.last_record_at !== null) {
      const gap = Date.parse(record.timestamp) - Date.parse(result.last_record_at);
      result.longest_gap_ms = result.longest_gap_ms === null ? gap : Math.max(result.longest_gap_ms, gap);
      if (!wholeCommands.open) quietGap = quietGap === null ? gap : Math.max(quietGap, gap);
    }
    wholeCommands.accept(record);
    result.records += 1;
    result.last_record_at = record.timestamp;
    result.last_record_kind = ['event_msg', 'response_item'].includes(record.type) &&
      typeof record.payload.type === 'string' ? `${record.type}/${record.payload.type}` : record.type;
    if (referenceValid && Date.parse(record.timestamp) <= Date.parse(referenceAt)) {
      referenceCommands.accept(record);
      reference.records += 1;
      reference.last_record_at = result.last_record_at;
      reference.last_record_kind = result.last_record_kind;
    }
  }
  return finish({ state: terminated ? 'observed' : 'incomplete' });
}
