/** Surfaces handback drift; 2026-09-25 established exact host transcript versions as identity. */
import path from 'node:path';
import { WITNESS_FILE } from '../src/home/lib/handback-witness.mjs';
import { entryState } from '../src/home/lib/observation-ledger.mjs';

export function handbackWitnessStatus({ record, hostVersion, stateDir }) {
  if (record?.corrupt) {
    return { state: 'unreadable', message: `The handback witness is unreadable; delete ${path.join(stateDir, WITNESS_FILE)} to reset it.` };
  }
  const entries = Object.values(record?.ledger?.entries || {});
  const violations = entries.filter((entry) => entryState(entry) === 'violation'
    && entry.lastObservation.data.hostVersion === hostVersion);
  if (violations.length > 0) {
    const details = violations.map((entry) => {
      const { data, detail, at } = entry.lastViolation;
      return `${data.cause}${data.agentType ? ` / ${data.agentType}` : ''}: ${detail} at ${at}`;
    });
    return {
      state: 'violation',
      message: `Dispatcher violation(s) on host ${hostVersion ?? 'unknown host'}: ${details.join('; ')}; do not trust a dispatcher answer from that time; see Plan_62 D15.`,
    };
  }
  const intercepted = record?.intercepted?.[hostVersion || 'unknown'];
  let message = intercepted
    ? `Newest intercepted handback on host ${hostVersion ?? 'unknown host'} at ${intercepted}.`
    : 'Not observed yet — a handback is seen only when a dispatcher runs in an interactive session.';
  const recovered = entries.filter((entry) => entryState(entry) === 'recovered').length;
  const historical = entries.filter((entry) => entryState(entry) === 'violation'
    && entry.lastObservation.data.hostVersion !== hostVersion).length;
  const legacy = record?.legacy || [];
  if (recovered || historical || legacy.length) {
    const untyped = legacy.filter((entry) => entry.disposition === 'legacy-untyped-unverified').length;
    const unclassified = legacy.filter((entry) => entry.disposition === 'unclassified').length;
    message += ` History: ${recovered} recovered entries; ${historical} unresolved entries on other hosts (historical, not current); ${untyped} older alarms without dispatcher evidence, kept for history (legacy-untyped-unverified); ${unclassified} unclassified legacy entries.`;
  }
  return { state: 'ok', message };
}
