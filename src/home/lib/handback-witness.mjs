/** records whether hosts and dispatchers keep the handback contract, per cause, over the observation ledger
 * Plan_67 D8 cures the eternal-warning defect with cause-specific evidence; D9 keeps old untyped
 * alarms without dispatcher evidence in legacy history, never as confirmed violations.
 */
import path from 'node:path';
import { transcriptHostVersion } from './host-version.mjs';
import {
  emptyLedger, normalizeLedger, readLedgerFile, reduceObservation, updateLedgerFile,
} from './observation-ledger.mjs';

export const WITNESS_FILE = 'handback-witness.json';
export const WITNESS_CAUSES = Object.freeze(['missing-agent-type', 'missing-ids', 'tools-outside-gate']);

export async function witnessHostVersion(payload) {
  return transcriptHostVersion(payload?.transcript_path);
}

const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const hostMap = (value) => object(value) && Object.values(value).every((at) => typeof at === 'string');
const alarmEntry = (entry) => object(entry)
  && (entry.hostVersion === null || typeof entry.hostVersion === 'string')
  && typeof entry.at === 'string' && typeof entry.detail === 'string';

function emptyWitness() {
  return { version: 2, ledger: emptyLedger(), intercepted: {}, legacy: [] };
}

export function witnessKey({ cause, hostVersion, agentType }) {
  if (!WITNESS_CAUSES.includes(cause)) throw new TypeError('cause must be a witness cause');
  if (hostVersion != null && typeof hostVersion !== 'string') {
    throw new TypeError('hostVersion must be a string or null');
  }
  const host = hostVersion || 'unknown';
  if (cause === 'missing-agent-type') return `${host}|${cause}`;
  if (typeof agentType !== 'string' || agentType.length === 0) {
    throw new TypeError('agentType is required for this witness cause');
  }
  return `${host}|${agentType}|${cause}`;
}

// Preserve the previous normalizer's accepted host-map and SDK shapes. SDK versions are not hosts.
function normalizeOldWitness(record) {
  if (!object(record) || !Array.isArray(record.alarms)) return null;
  if (record.alarms.every(alarmEntry) && hostMap(record.lastSeen)
    && !Object.hasOwn(record.lastSeen, 'sdkVersion') && !Object.hasOwn(record.lastSeen, 'at')) return record;
  const legacy = record.lastSeen === null || (object(record.lastSeen)
    && typeof record.lastSeen.sdkVersion === 'string' && typeof record.lastSeen.at === 'string');
  const legacyAlarm = (entry) => object(entry)
    && (entry.sdkVersion === null || typeof entry.sdkVersion === 'string') && typeof entry.at === 'string'
    && typeof entry.detail === 'string';
  if (legacy && record.alarms.every(legacyAlarm)) {
    return { lastSeen: {}, alarms: record.alarms.map(({ at, detail }) => ({ hostVersion: null, at, detail })) };
  }
  return null;
}

export function migrateWitness(parsed) {
  if (object(parsed) && Object.hasOwn(parsed, 'version')) {
    return parsed.version === 2 && normalizeLedger(parsed.ledger) && hostMap(parsed.intercepted)
      && Array.isArray(parsed.legacy) && parsed.legacy.every((entry) => alarmEntry(entry)
        && ['legacy-untyped-unverified', 'unclassified'].includes(entry.disposition)) ? parsed : null;
  }
  const old = normalizeOldWitness(parsed);
  if (!old) return null;
  const record = { ...emptyWitness(), intercepted: { ...old.lastSeen } };
  const alarms = [...old.alarms].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const { at, hostVersion, detail } of alarms) {
    if (/^host omitted agent_type for agent \S+$/.test(detail)) {
      // D9: old stops lack dispatcher evidence; reclassification must not manufacture a violation.
      record.legacy.push({ at, hostVersion, detail, disposition: 'legacy-untyped-unverified' });
      continue;
    }
    const ids = /^host omitted session_id or agent_id for (\S+)$/.exec(detail);
    const tools = /^(\S+) (\S+): (.+) outside the dispatcher gate$/.exec(detail);
    if (!ids && !tools) {
      record.legacy.push({ at, hostVersion, detail, disposition: 'unclassified' });
      continue;
    }
    const cause = ids ? 'missing-ids' : 'tools-outside-gate';
    const agentType = (ids || tools)[1];
    try {
      record.ledger = reduceObservation(record.ledger, {
        key: witnessKey({ cause, hostVersion, agentType }), verdict: 'violation', at, detail,
        data: { cause, hostVersion, agentType },
      });
    } catch {
      return null;
    }
  }
  return record;
}

// readLedgerFile returns an empty ledger for ENOENT, even when its normalizer is an adapter.
function witnessRecord(record) {
  return record.version !== 2 && record.format === 1 ? emptyWitness() : record;
}

export function readHandbackWitness({ stateDir }) {
  return witnessRecord(readLedgerFile(path.join(stateDir, WITNESS_FILE), { normalize: migrateWitness }));
}

function validateHost(hostVersion) {
  if (hostVersion !== null && typeof hostVersion !== 'string') {
    throw new TypeError('hostVersion must be a string or null');
  }
}

export async function recordWitnessObservation({
  stateDir, cause, hostVersion, agentType = null, verdict, detail = '', now = new Date(),
}) {
  return recordWitnessObservations({
    stateDir, observations: [{ cause, hostVersion, agentType, verdict, detail }], now,
  });
}

export async function recordWitnessObservations({ stateDir, observations, now = new Date() }) {
  const prepared = observations.map(({ cause, hostVersion, agentType = null, verdict, detail = '' }) => {
    validateHost(hostVersion);
    const key = witnessKey({ cause, hostVersion, agentType });
    if (agentType !== null && (typeof agentType !== 'string' || agentType.length === 0)) {
      throw new TypeError('agentType must be a non-empty string or null');
    }
    return { key, verdict, detail, data: { cause, hostVersion, agentType } };
  });
  const at = new Date(now).toISOString();
  return updateLedgerFile({
    stateDir, id: 'handback-witness', file: path.join(stateDir, WITNESS_FILE), normalize: migrateWitness,
    update: (current) => {
      const record = witnessRecord(current);
      return { ...record, ledger: prepared.reduce((ledger, observation) =>
        reduceObservation(ledger, { ...observation, at }), record.ledger) };
    },
  });
}

export async function recordInterceptedAttempt({ stateDir, hostVersion, now = new Date() }) {
  validateHost(hostVersion);
  const at = new Date(now).toISOString();
  return updateLedgerFile({
    stateDir, id: 'handback-witness', file: path.join(stateDir, WITNESS_FILE), normalize: migrateWitness,
    update: (current) => {
      const record = witnessRecord(current);
      // D8: even denied handbacks are intercepted, so this timestamp is never match evidence.
      return { ...record, intercepted: { ...record.intercepted, [hostVersion || 'unknown']: at } };
    },
  });
}
