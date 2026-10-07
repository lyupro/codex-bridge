/** Keeps, per key, the last observation apart from the last confirmed violation and the last confirmed match.
 * Plan_67 D8 separates these facts to cure the eternal witness warning: an undetermined observation
 * cannot clear a violation, while a later confirmed match can. Adapters own causes and severity.
 */
import fs from 'node:fs';
import { writeHomeJsonAtomic } from './atomic-json.mjs';
import { withHomeFileLock } from './file-lock.mjs';
import { stateDirWriter } from './home-write.mjs';
import { parseJsonText } from './json-file.mjs';

export const HISTORY_LIMIT = 20;
const VERDICTS = new Set(['violation', 'match', 'undetermined']);
const has = (object, key) => Object.hasOwn(object, key);
const plainObject = (value) => value !== null && typeof value === 'object'
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function fields(value, required, optional = []) {
  return plainObject(value) && required.every((key) => has(value, key))
    && Reflect.ownKeys(value).every((key) => required.includes(key) || optional.includes(key));
}

function jsonValue(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if ((!Array.isArray(value) && !plainObject(value)) || ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? Array.from(value).every((item) => jsonValue(item, ancestors))
    : Reflect.ownKeys(value).every((key) => typeof key === 'string' && jsonValue(value[key], ancestors));
  ancestors.delete(value);
  return valid;
}

function isoTimestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return false;
  const parts = /^(\d{4}|[+-]\d{6})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts) return false;
  const [, year, month, day, hour, minute, second] = parts.map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
    && hour < 24 && minute < 60 && second < 60;
}

function validObservation(value, maxSeq) {
  return fields(value, ['seq', 'verdict', 'at', 'detail'], ['data'])
    && Number.isInteger(value.seq) && value.seq > 0 && value.seq <= maxSeq
    && VERDICTS.has(value.verdict) && isoTimestamp(value.at) && typeof value.detail === 'string'
    && (!has(value, 'data') || (plainObject(value.data) && jsonValue(value.data)));
}

function validEntry(entry, maxSeq) {
  if (!fields(entry, ['lastObservation', 'lastViolation', 'lastMatch', 'history'])
    || !validObservation(entry.lastObservation, maxSeq)
    || !Array.isArray(entry.history) || entry.history.length > HISTORY_LIMIT) return false;
  const lastSeq = entry.lastObservation.seq;
  if (entry.lastViolation !== null && (!validObservation(entry.lastViolation, lastSeq)
    || entry.lastViolation.verdict !== 'violation')) return false;
  if (entry.lastMatch !== null && (!validObservation(entry.lastMatch, lastSeq)
    || entry.lastMatch.verdict !== 'match')) return false;
  let previous = 0;
  for (const observation of entry.history) {
    if (!validObservation(observation, lastSeq) || observation.verdict !== 'violation'
      || observation.seq <= previous) return false;
    previous = observation.seq;
  }
  if (entry.lastViolation === null ? entry.history.length !== 0 : previous !== entry.lastViolation.seq) return false;
  const slot = entry.lastObservation.verdict === 'violation' ? entry.lastViolation
    : entry.lastObservation.verdict === 'match' ? entry.lastMatch : null;
  return entry.lastObservation.verdict === 'undetermined' || slot?.seq === lastSeq;
}

export function emptyLedger() {
  return { format: 1, seq: 0, entries: {} };
}

export function normalizeLedger(parsed) {
  if (!fields(parsed, ['format', 'seq', 'entries']) || parsed.format !== 1
    || !Number.isInteger(parsed.seq) || parsed.seq < 0 || !plainObject(parsed.entries)) return null;
  return Reflect.ownKeys(parsed.entries).every((key) => typeof key === 'string' && key.length > 0
    && validEntry(parsed.entries[key], parsed.seq)) ? parsed : null;
}

export function reduceObservation(ledger, { key, verdict, at, detail, data }) {
  if (!VERDICTS.has(verdict)) throw new TypeError('verdict must be violation, match or undetermined');
  if (typeof key !== 'string' || key.length === 0) throw new TypeError('key must be a non-empty string');
  if (!isoTimestamp(at)) throw new TypeError('at must be an ISO timestamp');
  if (typeof detail !== 'string') throw new TypeError('detail must be a string');
  if (data !== undefined && (!plainObject(data) || !jsonValue(data))) {
    throw new TypeError('data must be a plain JSON object');
  }
  if (!normalizeLedger(ledger)) throw new TypeError('ledger must be a valid observation ledger');
  const seq = ledger.seq + 1;
  if (seq === ledger.seq) throw new TypeError('ledger sequence cannot increment');
  const observation = { seq, verdict, at, detail };
  if (data !== undefined) observation.data = structuredClone(data);
  const previous = has(ledger.entries, key) ? ledger.entries[key]
    : { lastObservation: null, lastViolation: null, lastMatch: null, history: [] };
  const entry = { ...previous, lastObservation: observation };
  if (verdict === 'violation') {
    entry.lastViolation = observation;
    entry.history = [...previous.history, observation].slice(-HISTORY_LIMIT);
  } else if (verdict === 'match') {
    entry.lastMatch = observation;
  }
  return { format: 1, seq, entries: { ...ledger.entries, [key]: entry } };
}

export function entryState(entry) {
  if (!entry) return 'unobserved';
  if (entry.lastViolation) {
    return entry.lastMatch?.seq > entry.lastViolation.seq ? 'recovered' : 'violation';
  }
  return entry.lastMatch ? 'clean' : 'undetermined';
}

export function readLedgerFile(file, { normalize = normalizeLedger } = {}) {
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return error.code === 'ENOENT' ? emptyLedger() : { corrupt: true };
  }
  try {
    return normalize(parseJsonText(file, source)) ?? { corrupt: true };
  } catch {
    return { corrupt: true };
  }
}

export async function updateLedgerFile({ stateDir, id, file, normalize, update }) {
  const writer = stateDirWriter(stateDir);
  // Plan_67 D8: allocation of seq and publication share the registered artifact's lock.
  return withHomeFileLock(writer, id, `${file}.lock`, async () => {
    const current = readLedgerFile(file, { normalize });
    if (current.corrupt) throw new Error(`Cannot update corrupt observation ledger: ${file}`);
    const next = update(current);
    writeHomeJsonAtomic(writer, id, file, next);
    return next;
  }, { description: 'observation ledger' });
}

export async function recordObservation({ stateDir, id, file, observation }) {
  return updateLedgerFile({ stateDir, id, file, update: (current) => reduceObservation(current, observation) });
}
