/**
 * Reports shadow watchdog outcomes as diagnostics: Plan_80 E25 retired silence
 * stopping. Only faults, unknown versions and armed records warn; an armed record
 * indicates an older or foreign package armed stopping after E25.
 */
import { check } from './doctor-format.mjs';
import { scanRunRecords } from './doctor-run-records.mjs';

const REVIEW = '; inspect watchdog faults, unknown record versions and armed records';
const DIAGNOSTIC = '; diagnostic only: silence never stops a run (Plan_80 E25)';

function bucket(meta) {
  const stop = meta.stop;
  if (!stop || typeof stop !== 'object' || Array.isArray(stop) || stop.watchdog == null) return 'not-recorded';
  const watchdog = stop.watchdog;
  if (stop.version !== 2 || watchdog.version !== 1) return 'unknown-version';
  if (watchdog.arming === 'off' || watchdog.arming === 'armed') return watchdog.arming;
  if (watchdog.arming !== 'shadow') return 'unknown-version';
  if (watchdog.fault != null) return 'fault';
  const decision = watchdog.decision;
  if (decision != null) {
    if (decision.action !== 'recorded' || typeof decision.at !== 'string'
      || typeof decision.confirmed_at !== 'string' || !Number.isFinite(decision.silence_ms)
      || !(watchdog.checks >= 2) || !Number.isInteger(watchdog.threshold_ms) || watchdog.threshold_ms <= 0) {
      return 'unknown-version';
    }
    if (meta.status === 'OK') return 'false-stop';
    return stop.trigger === 'deadline' ? 'true-stop' : 'other-outcome';
  }
  return watchdog.last_observation?.state === 'observed' ? 'observed-no-decision' : 'not-observed';
}

export function silenceWatchdogShadowCheck({ runsRoot, now = Date.now(), days = 30, records }) {
  const scan = records ?? scanRunRecords({ runsRoot, now, days });
  if (scan.error) return check('silenceWatchdogShadow', 'warn', scan.error);
  const outside = { off: 0, armed: 0, 'not-recorded': 0, 'unknown-version': 0 };
  const groups = new Map();
  for (const { project, run, meta } of scan.records) {
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) continue;
    const outcome = bucket(meta);
    if (Object.hasOwn(outside, outcome)) {
      outside[outcome] += 1;
      continue;
    }
    const key = `${meta.silence_policy?.role}.${meta.silence_policy?.phase}`;
    const group = groups.get(key) ?? {
      count: 0, thresholds: new Set(), falseStops: [], 'false-stop': 0, 'true-stop': 0,
      'other-outcome': 0, 'observed-no-decision': 0, 'not-observed': 0, fault: 0,
    };
    group.count += 1;
    group[outcome] += 1;
    group.thresholds.add(meta.stop.watchdog.threshold_ms);
    if (outcome === 'false-stop') group.falseStops.push({ project, run });
    groups.set(key, group);
  }

  let value = groups.size ? [...groups.keys()].sort().map((key) => {
    const group = groups.get(key);
    const thresholds = [...group.thresholds].sort((a, b) => a - b).join('/');
    let text = `${key} (threshold ${thresholds} ms): ${group.count} shadow runs — `
      + `would stop on OK ${group['false-stop']}, on deadline ${group['true-stop']}, `
      + `other outcome ${group['other-outcome']}; observed without a decision ${group['observed-no-decision']}; `
      + `not observed ${group['not-observed']}; faults ${group.fault}`;
    if (group.falseStops.length) {
      const runs = group.falseStops.sort((a, b) => a.run < b.run ? -1 : a.run > b.run ? 1 : 0);
      const names = runs.slice(0, 5).map(({ project, run }) => `${project}/${run}`).join(', ');
      text += ` [${names}${runs.length > 5 ? `, and ${runs.length - 5} more` : ''}]`;
    }
    return text;
  }).join('; ') : `no shadow watchdog record in the last ${scan.days} days`;
  value += `; outside the shadow cohort: off ${outside.off}, armed ${outside.armed}, not recorded ${outside['not-recorded']}, unknown version ${outside['unknown-version']}`;
  if (scan.unreadable) value += `, ${scan.unreadable} unreadable records skipped`;
  const warn = outside['unknown-version'] > 0 || outside.armed > 0
    || [...groups.values()].some((group) => group.fault > 0);
  if (warn) value += REVIEW;
  if (groups.size) value += DIAGNOSTIC;
  return check('silenceWatchdogShadow', warn ? 'warn' : 'ok', value);
}
