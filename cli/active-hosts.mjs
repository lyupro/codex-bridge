/** Names the hosts whose dispatchers ran in the last 24 hours, the hosts whose witness and model state is active;
 * Plan_67 D12: concurrent VS Code hosts 2.1.291 and 2.1.292 on 2026-10-07 must both be judged, regardless of session liveness.
 */
export const ACTIVE_HOST_WINDOW_MS = 24 * 60 * 60 * 1000;

export function activeHostVersions({ observations, witnessRecord, modelRecord, now = new Date() }) {
  const currentTime = new Date(now).getTime();
  const activity = new Map();
  function recordActivity(version, at) {
    if (typeof version !== 'string' || !version || version === 'unknown') return;
    if (typeof at !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(at)) return;
    const time = Date.parse(at);
    const date = Date.parse(`${at.slice(0, 10)}T00:00:00Z`);
    if (!Number.isFinite(time) || !Number.isFinite(date)
      || new Date(date).toISOString().slice(0, 10) !== at.slice(0, 10)) return;
    // Plan_67 R2: future evidence must not hide a valid past source for the same host.
    if (time > currentTime) return;
    if (!activity.has(version) || time > activity.get(version)) activity.set(version, time);
  }
  function ledgerActivity(ledger) {
    if (!ledger || ledger.corrupt) return;
    for (const entry of Object.values(ledger.entries || {})) {
      if (!entry || entry.corrupt || entry.lastObservation?.corrupt) continue;
      const observation = entry.lastObservation;
      recordActivity(observation?.data?.hostVersion, observation?.at);
    }
  }
  if (observations && !observations.corrupt) {
    for (const [version, host] of Object.entries(observations.hosts || {})) {
      if (host && !host.corrupt) recordActivity(version, host.lastSeen);
    }
    for (const session of Object.values(observations.sessions || {})) {
      if (session && !session.corrupt) recordActivity(session.version, session.at);
    }
  }
  if (witnessRecord && !witnessRecord.corrupt) {
    for (const [version, at] of Object.entries(witnessRecord.intercepted || {})) recordActivity(version, at);
    ledgerActivity(witnessRecord.ledger);
  }
  ledgerActivity(modelRecord);
  return [...activity].filter(([, at]) => currentTime - at >= 0 && currentTime - at <= ACTIVE_HOST_WINDOW_MS)
    .sort((a, b) => b[1] - a[1]).map(([version]) => version);
}
