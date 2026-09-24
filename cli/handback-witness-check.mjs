/** Surfaces handback drift because the 2026-09-17..24 contract break went unnoticed for a week. */
import path from 'node:path';
import { WITNESS_FILE } from '../src/home/lib/handback-witness.mjs';

function versionParts(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:\s|$)/);
  return match ? { version: match[0].trim(), patch: match[3] } : null;
}

export function handbackWitnessStatus({ record, hostVersion, stateDir }) {
  if (record?.corrupt) {
    return { state: 'unreadable', message: `The handback witness is unreadable; delete ${path.join(stateDir, WITNESS_FILE)} to reset it.` };
  }
  if (record?.alarms?.length > 0) {
    const alarm = record.alarms.at(-1);
    return {
      state: 'alarm',
      message: `${record.alarms.length} dispatcher alarm(s); newest: ${alarm.detail} at ${alarm.at}; do not trust a dispatcher answer from that time; see Plan_62 D15.`,
    };
  }
  if (!record?.lastSeen) {
    return { state: 'unobserved', message: 'Not observed yet — a handback is seen only when a dispatcher runs in an interactive session.' };
  }

  const seen = versionParts(record.lastSeen.sdkVersion);
  const host = versionParts(hostVersion);
  // Plan_62 D9 pairs observed SDK 0.3.281 inside Claude Code 2.1.281 hooks; matching patches are current.
  if (seen && host && seen.patch !== host.patch) {
    return {
      state: 'stale',
      message: `Last seen on SDK ${record.lastSeen.sdkVersion} at ${record.lastSeen.at}; current host ${hostVersion}; run any dispatcher once in an interactive session to observe it again.`,
    };
  }
  return {
    state: 'seen',
    message: `Handback contract last seen on SDK ${record.lastSeen.sdkVersion} (host ${hostVersion}) at ${record.lastSeen.at}.`,
  };
}
