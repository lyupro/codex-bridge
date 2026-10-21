/** Reports advise deadline stops by recorded budget under Plan_80 E32 and E35. */
import path from 'node:path';
import { check } from './doctor-format.mjs';
import { scanRunRecords } from './doctor-run-records.mjs';
import { readRunConfig } from '../src/home/lib/run-config.mjs';
import { readJsonFileSync } from '../src/home/lib/json-file.mjs';

// Plan_80 E35 requires three healthy slow passes on the current budget before warning.
const HEALTHY_SLOW_WARNING_THRESHOLD = 3;

function emptyGroup() {
  return { 'recent-activity': 0, 'silent-stall-candidate': 0, other: 0 };
}

function groupValue(label, budget, group) {
  return `${label} ${budget} min: recent-activity ${group['recent-activity']}, `
    + `silent-stall-candidate ${group['silent-stall-candidate']}, other ${group.other}`;
}

export function adviseDeadlineCheck({ runsRoot, now = Date.now(), days = 30, records, currentBudgetMinutes }) {
  const scan = records ?? scanRunRecords({ runsRoot, now, days });
  if (scan.error) return check('adviseDeadline', 'warn', scan.error);
  if (currentBudgetMinutes === undefined) {
    try {
      currentBudgetMinutes = readRunConfig().budgets.advisor.advise;
    } catch (error) {
      return check('adviseDeadline', 'warn', `current advise budget unavailable: ${error.message}`);
    }
  }

  const current = emptyGroup();
  const groups = new Map([[currentBudgetMinutes, current]]);
  let unknown = 0;
  for (const { meta, runDir } of scan.records) {
    if (meta?.agent !== 'codex-advisor' || meta.phase !== 'advise'
      || meta.status !== 'FAIL' || meta.stop?.trigger !== 'deadline') continue;
    let budget;
    try {
      budget = readJsonFileSync(path.join(runDir, 'worker.json'))?.budget_minutes;
    } catch {
      // Missing or unreadable allocation evidence must not be assigned to the current budget.
    }
    if (!Number.isFinite(budget) || budget <= 0) {
      unknown += 1;
      continue;
    }
    const kind = meta.situation?.kind;
    const bucket = kind === 'recent-activity' || kind === 'silent-stall-candidate' ? kind : 'other';
    const group = groups.get(budget) ?? emptyGroup();
    group[bucket] += 1;
    groups.set(budget, group);
  }

  let value = `advise passes stopped by the deadline in the last ${scan.days} days — `
    + groupValue('current budget', currentBudgetMinutes, current);
  for (const budget of [...groups.keys()].filter((budget) => budget !== currentBudgetMinutes).sort((a, b) => a - b)) {
    value += `; ${groupValue('earlier budget', budget, groups.get(budget))}`;
  }
  if (unknown) value += `; budget unknown ${unknown}`;
  if (scan.unreadable) value += `, ${scan.unreadable} unreadable records skipped`;

  const healthySlow = current['recent-activity'];
  const warn = healthySlow >= HEALTHY_SLOW_WARNING_THRESHOLD;
  if (warn) value += `; ${healthySlow} healthy slow advise passes were killed by the ${currentBudgetMinutes}-minute deadline: `
    + 'consider the 45-minute fallback for advise in src/home/lib/agents.mjs (Plan_80 E32), then release';
  return check('adviseDeadline', warn ? 'warn' : 'ok', value);
}
