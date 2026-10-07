/** turns the dispatcher-model ledger into doctor rows; Plan_67 D4/D8/D12 judge every recently active host. */
import path from 'node:path';
import { DISPATCHER_MODEL_FILE } from '../src/home/lib/dispatcher-model.mjs';
import { entryState } from '../src/home/lib/observation-ledger.mjs';
import { check } from './doctor-format.mjs';

function observationSummary({ data, at }) {
  return `${data.agentType}: observed families ${data.parsed.join(', ')}, pinned family ${data.pinFamily} at ${at}`;
}

function entryCheck(entry) {
  const observation = entry.lastObservation;
  const { data, verdict, at } = observation;
  const key = `dispatcherModel:${data.agentType}`;
  const prefix = `host ${data.hostVersion}: `;
  const state = entryState(entry);
  // D4: only the latest confirmed violation fails; D8 keeps uncertainty from erasing history.
  if (verdict === 'violation') {
    return check(key, 'fail', `${prefix}${observationSummary(observation)}; Claude quota was spent on this dispatcher; see Plan_67.`);
  }
  if (verdict === 'undetermined') {
    const reason = data.pinReasons?.length
      // Reasons are sentences ending in a period; the row adds its own (live doctor printed "record..").
      ? data.pinReasons.map((text) => text.replace(/\.$/, '')).join('; ') : 'no model family could be read from the transcript';
    const unresolved = state === 'violation'
      ? `; earlier violation (${observationSummary(entry.lastViolation)}) is not yet disproved` : '';
    return check(key, 'warn', `${prefix}${data.agentType}: model observation undetermined at ${at}: ${reason}${unresolved}.`);
  }
  const history = state === 'recovered'
    ? `; recovered from earlier violation (${observationSummary(entry.lastViolation)})` : '';
  return check(key, 'ok', `${prefix}${observationSummary(observation)}; matches the installed contract${history}.`);
}

export function dispatcherModelChecks({ record, activeHosts, stateDir }) {
  if (record?.corrupt) {
    return [check('dispatcherModel', 'warn',
      `The dispatcher model record is unreadable; delete ${path.join(stateDir, DISPATCHER_MODEL_FILE)} to reset it.`)];
  }
  const entries = Object.values(record?.entries || {});
  const current = entries.filter((entry) => activeHosts.includes(entry.lastObservation.data.hostVersion));
  const rows = current.map(entryCheck);
  if (!rows.length) {
    rows.push(check('dispatcherModel', 'ok', 'Not observed in the last 24 hours — recorded when a dispatcher stops.'));
  }
  const hosts = new Map();
  for (const entry of entries) {
    const version = entry.lastObservation.data.hostVersion;
    if (activeHosts.includes(version)) continue;
    const counts = hosts.get(version) || { entries: 0, violations: 0 };
    counts.entries += 1;
    if (entryState(entry) === 'violation') counts.violations += 1;
    hosts.set(version, counts);
  }
  // D12: inactive hosts are one history sentence, never additional active warning rows.
  if (hosts.size) {
    const history = [...hosts].map(([version, counts]) =>
      `${version ?? 'unknown host'}: ${counts.entries} entries, ${counts.violations} unresolved violations`);
    rows[0].value += ` History on hosts without dispatcher activity in the last 24 hours (historical, not current): ${history.join('; ')}.`;
  }
  return rows;
}
