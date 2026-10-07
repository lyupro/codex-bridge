/** Surfaces handback drift; Plan_67 D12 judges every host with recent dispatcher activity. */
import path from 'node:path';
import { WITNESS_FILE } from '../src/home/lib/handback-witness.mjs';
import { entryState } from '../src/home/lib/observation-ledger.mjs';

export function handbackWitnessStatus({ record, activeHosts, stateDir }) {
  if (record?.corrupt) {
    return { state: 'unreadable', message: `The handback witness is unreadable; delete ${path.join(stateDir, WITNESS_FILE)} to reset it.` };
  }
  const entries = Object.values(record?.ledger?.entries || {});
  const violations = entries.filter((entry) => entryState(entry) === 'violation'
    && activeHosts.includes(entry.lastObservation.data.hostVersion));
  if (violations.length > 0) {
    const details = violations.map((entry) => {
      const { data, detail, at } = entry.lastViolation;
      return `host ${data.hostVersion}: ${data.cause}${data.agentType ? ` / ${data.agentType}` : ''}: ${detail} at ${at}`;
    });
    return {
      state: 'violation',
      message: `Dispatcher violation(s): ${details.join('; ')}; do not trust a dispatcher answer from that time; see Plan_62 D15.`,
    };
  }
  const intercepted = activeHosts.filter((host) => record?.intercepted?.[host])
    .map((host) => `host ${host} at ${record.intercepted[host]}`);
  let message = !activeHosts.length
    ? 'No dispatcher activity in the last 24 hours.'
    : intercepted.length
      ? `Newest intercepted handback on ${intercepted.join('; ')}.`
      : 'Not observed yet — a handback is seen only when a dispatcher runs in an interactive session.';
  const recovered = entries.filter((entry) => entryState(entry) === 'recovered').length;
  const historical = entries.filter((entry) => entryState(entry) === 'violation'
    && !activeHosts.includes(entry.lastObservation.data.hostVersion)).length;
  const legacy = record?.legacy || [];
  if (recovered || historical || legacy.length) {
    const untyped = legacy.filter((entry) => entry.disposition === 'legacy-untyped-unverified').length;
    const unclassified = legacy.filter((entry) => entry.disposition === 'unclassified').length;
    message += ` History: ${recovered} recovered entries; ${historical} unresolved entries on hosts without dispatcher activity in the last 24 hours (history); ${untyped} older alarms without dispatcher evidence, kept for history (legacy-untyped-unverified); ${unclassified} unclassified legacy entries.`;
  }
  return { state: 'ok', message };
}
