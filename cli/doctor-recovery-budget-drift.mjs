/** Reports automatic recovery budget drift under Plan_80 E15 (2) and E19. */
import { check } from './doctor-format.mjs';
import { scanRunRecords } from './doctor-run-records.mjs';
import { automaticChildMarker, abortedPreStart } from '../src/home/lib/meta/pre-start.mjs';
import { RECOVERY_CALIBRATIONS, deriveRecoveryBudgetMs } from '../src/home/lib/recovery-policy.mjs';

// Arbiter A12 requires twenty complete successful children before suggesting a lower budget.
const DOWNWARD_MIN_CHILDREN = 20;
const RELEASE = '; change the budget and its evidence in recovery-policy.mjs together, then release';

function bucket(record) {
  if (abortedPreStart(record.runDir)) return 'not-started';
  const meta = record.meta;
  if (meta?.recovery_policy?.version !== 1 || meta?.stop?.version !== 2) return 'unknown-version';
  if (!Number.isInteger(meta.recovery_policy.budget_ms) || meta.recovery_policy.budget_ms <= 0
    || !Number.isFinite(meta.stop.elapsed_ms) || meta.stop.elapsed_ms < 0) return 'incomplete';
  if (meta.stop.trigger === 'deadline') return 'deadline';
  return meta.status === 'OK' ? 'ok' : 'other-outcome';
}

export function recoveryBudgetDriftCheck({ runsRoot, now = Date.now(), days = 30, records }) {
  const scan = records ?? scanRunRecords({ runsRoot, now, days });
  if (scan.error) return check('recoveryBudgetDrift', 'warn', scan.error);
  const groups = new Map();
  const outside = { 'not-started': 0, 'unknown-version': 0 };
  let children = 0;
  for (const record of scan.records) {
    if (automaticChildMarker(record.status) !== true) continue;
    children += 1;
    const outcome = bucket(record);
    if (Object.hasOwn(outside, outcome)) {
      outside[outcome] += 1;
      continue;
    }
    const policy = record.meta.recovery_policy;
    const key = `${policy.role}.${policy.phase}`;
    const calibration = policy.calibration?.id ?? 'none';
    const identity = JSON.stringify([key, policy.budget_ms, calibration]);
    const group = groups.get(identity) ?? {
      key, budget: policy.budget_ms, calibration, count: 0,
      ok: 0, deadline: 0, 'other-outcome': 0, incomplete: 0, longestOk: 0,
    };
    group.count += 1;
    group[outcome] += 1;
    if (outcome === 'ok') group.longestOk = Math.max(group.longestOk, record.meta.stop.elapsed_ms);
    groups.set(identity, group);
  }

  const cohorts = [...groups.values()].sort((a, b) => {
    if (a.key !== b.key) return a.key < b.key ? -1 : 1;
    if (a.budget !== b.budget) return a.budget - b.budget;
    return a.calibration < b.calibration ? -1 : a.calibration > b.calibration ? 1 : 0;
  });
  let value = children === 0 ? `automatic recovery not exercised in the last ${scan.days} days`
    : cohorts.map((group) => `${group.key} budget ${group.budget} ms (calibration ${group.calibration}): `
      + `${group.count} children — OK ${group.ok}${group.ok > 0 ? ` (longest ${group.longestOk} ms)` : ''}, `
      + `deadline ${group.deadline}, other outcome ${group['other-outcome']}, incomplete ${group.incomplete}`).join('; ');
  if (outside['not-started']) value += `; not started ${outside['not-started']}`;
  if (outside['unknown-version']) value += `; unknown version ${outside['unknown-version']}`;
  if (scan.unreadable) value += `, ${scan.unreadable} unreadable records skipped`;

  const deadline = cohorts.some((group) => group.deadline > 0);
  if (deadline) value += '; children ran into their recovery budget: investigate and recalibrate upward';
  let downward = false;
  for (const group of cohorts) {
    if (group.ok < DOWNWARD_MIN_CHILDREN || group.deadline !== 0 || group.incomplete !== 0
      || !Object.hasOwn(RECOVERY_CALIBRATIONS, group.key)) continue;
    const candidate = Math.ceil(group.longestOk * 1.2 / 1000) * 1000;
    if (candidate >= group.budget || candidate >= deriveRecoveryBudgetMs(RECOVERY_CALIBRATIONS[group.key])) continue;
    downward = true;
    value += `; ${group.ok} complete successful children in ${group.key} support ${candidate} ms: review the cohort and recalibrate downward`;
  }
  if (outside['unknown-version']) value += '; inspect run records of an unknown version';
  if (deadline || downward) value += RELEASE;
  return check('recoveryBudgetDrift', deadline || downward || outside['unknown-version'] > 0 ? 'warn' : 'ok', value);
}
