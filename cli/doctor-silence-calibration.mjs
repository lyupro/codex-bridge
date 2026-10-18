/**
 * Reports whether successful runs have outgrown their frozen silence threshold.
 * Plan_80 E12: the threshold ships with the package, so calibration drift must be
 * visible on the host before it misclassifies a healthy run as stalled.
 */
import { check } from './doctor-format.mjs';
import { scanRunRecords } from './doctor-run-records.mjs';

const RECALIBRATE = '; recalibrate: measure the longest quiet pause of successful runs from Codex session logs and change the threshold together with its evidence in silence-policy.mjs, then release';

export function silenceCalibrationCheck({ runsRoot, now = Date.now(), days = 30, records }) {
  const scan = records ?? scanRunRecords({ runsRoot, now, days });
  if (scan.error) return check('silenceCalibration', 'warn', scan.error);
  const groups = new Map();
  for (const { meta } of scan.records) {
    const policy = meta?.silence_policy;
    const gap = meta?.stop?.session?.longest_quiet_gap_ms;
    if (meta?.status !== 'OK' || typeof policy?.threshold_ms !== 'number' || typeof gap !== 'number') continue;
    const key = `${policy.role}.${policy.phase}`;
    const group = groups.get(key) ?? { count: 0, breaches: 0, longest: -Infinity, thresholds: new Set() };
    group.count += 1;
    group.breaches += gap >= policy.threshold_ms ? 1 : 0;
    group.longest = Math.max(group.longest, gap);
    group.thresholds.add(policy.threshold_ms);
    groups.set(key, group);
  }

  const breached = [...groups.values()].some((group) => group.breaches > 0);
  let value = groups.size ? [...groups.keys()].sort().map((key) => {
    const group = groups.get(key);
    const thresholds = [...group.thresholds].sort((a, b) => a - b).join('/');
    return `${key}: ${group.breaches} of ${group.count} successful runs reached ${thresholds} ms (longest quiet pause ${group.longest} ms)`;
  }).join('; ') : `no successful run with recorded pauses in the last ${scan.days} days`;
  if (breached) value += RECALIBRATE;
  if (scan.unreadable) value += `, ${scan.unreadable} unreadable records skipped`;
  return check('silenceCalibration', breached ? 'warn' : 'ok', value);
}
