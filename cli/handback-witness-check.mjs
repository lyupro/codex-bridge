/** Surfaces handback drift; 2026-09-25 established exact host transcript versions as identity. */
import path from 'node:path';
import { WITNESS_FILE } from '../src/home/lib/handback-witness.mjs';

export function handbackWitnessStatus({ record, hostVersion, stateDir }) {
  if (record?.corrupt) {
    return { state: 'unreadable', message: `The handback witness is unreadable; delete ${path.join(stateDir, WITNESS_FILE)} to reset it.` };
  }
  if (record?.alarms?.length > 0) {
    const alarm = record.alarms.at(-1);
    return {
      state: 'alarm',
      message: `${record.alarms.length} dispatcher alarm(s); newest on ${alarm.hostVersion ?? 'unknown host'}: ${alarm.detail} at ${alarm.at}; do not trust a dispatcher answer from that time; see Plan_62 D15.`,
    };
  }
  if (!record?.lastSeen || Object.keys(record.lastSeen).length === 0) {
    return { state: 'unobserved', message: 'Not observed yet — a handback is seen only when a dispatcher runs in an interactive session.' };
  }

  if (record.lastSeen[hostVersion]) {
    return { state: 'seen', message: `Handback contract last seen on host ${hostVersion} at ${record.lastSeen[hostVersion]}.` };
  }
  const [newest, iso] = Object.entries(record.lastSeen).sort((left, right) => right[1].localeCompare(left[1]))[0];
  if (newest) {
    return {
      state: 'stale',
      message: `Handback contract last seen on host ${newest} at ${iso}, not yet on host ${hostVersion}; it is recorded the next time a dispatcher runs in an interactive session on that host.`,
    };
  }
  return { state: 'unobserved', message: 'Not observed yet — a handback is seen only when a dispatcher runs in an interactive session.' };
}
