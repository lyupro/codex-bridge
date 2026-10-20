/**
 * Reports successful pauses against frozen thresholds as diagnostics: Plan_80 E25
 * retired silence-based stopping. Continuations use their pass window because
 * the shared Codex thread can include the stalled parent's quiet pause.
 */
import { check } from './doctor-format.mjs';
import { scanRunRecords } from './doctor-run-records.mjs';

const DIAGNOSTIC = '; diagnostic only: silence never stops a run (Plan_80 E25)';

export function silenceCalibrationCheck({ runsRoot, now = Date.now(), days = 30, records }) {
  const scan = records ?? scanRunRecords({ runsRoot, now, days });
  if (scan.error) return check('silenceCalibration', 'warn', scan.error);
  const groups = new Map();
  let skippedContinuations = 0;
  for (const { meta } of scan.records) {
    const policy = meta?.silence_policy;
    if (meta?.status !== 'OK' || typeof policy?.threshold_ms !== 'number') continue;
    const session = meta?.stop?.session;
    let gap = session?.pass_longest_quiet_gap_ms;
    if (typeof gap !== 'number') {
      if (meta.resumed_from != null) {
        skippedContinuations += 1;
        continue;
      }
      gap = session?.longest_quiet_gap_ms;
    }
    if (typeof gap !== 'number') continue;
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
  if (breached) value += DIAGNOSTIC;
  if (skippedContinuations) value += `, ${skippedContinuations} continuation runs without a pass-window pause skipped`;
  if (scan.unreadable) value += `, ${scan.unreadable} unreadable records skipped`;
  return check('silenceCalibration', 'ok', value);
}
