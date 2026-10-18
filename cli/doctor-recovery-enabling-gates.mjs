/** Reports manual recovery enabling evidence under Plan_80 E15 (1) and E19. */
import path from 'node:path';
import { check } from './doctor-format.mjs';
import { scanRunRecords } from './doctor-run-records.mjs';
import { automaticChildMarker } from '../src/home/lib/meta/pre-start.mjs';
import { resumeOrigin } from '../src/home/lib/meta/sandbox-witness.mjs';
import { readJsonFileSync } from '../src/home/lib/json-file.mjs';

// Plan_80 E15 (1) requires three distinct stalled parents continued by hand before reviewing O8.
const ENABLING_TRIALS = 3;

export function recoveryEnablingGatesCheck({ runsRoot, now = Date.now(), days = 30, records }) {
  const scan = records ?? scanRunRecords({ runsRoot, now, days });
  if (scan.error) return check('recoveryEnablingGates', 'warn', scan.error);
  const parentMeta = new Map(scan.records.map((record) => [
    path.join(runsRoot, record.project, record.run, 'meta.json'), record.meta,
  ]));
  const parents = new Set();
  let trials = 0;
  let ok = 0;
  let within = 0;
  let over = 0;
  let timingUnknown = 0;
  let parentUnknown = 0;
  for (const record of scan.records) {
    const origin = resumeOrigin(record.meta);
    if (!origin || record.status === null || typeof record.status !== 'object'
      || resumeOrigin(record.status) !== origin || automaticChildMarker(record.status)) continue;
    const parentPath = path.join(runsRoot, record.project, origin, 'meta.json');
    if (!parentMeta.has(parentPath)) {
      try {
        parentMeta.set(parentPath, readJsonFileSync(parentPath));
      } catch {
        parentMeta.set(parentPath, null);
      }
    }
    const parent = parentMeta.get(parentPath);
    if (parent === null || typeof parent !== 'object' || Array.isArray(parent)) {
      parentUnknown += 1;
      continue;
    }
    if (parent.agent !== 'codex-advisor' || parent.phase !== 'advise'
      || parent.situation?.kind !== 'silent-stall-candidate') continue;
    trials += 1;
    parents.add(JSON.stringify([record.project, origin]));
    const meta = record.meta;
    if (meta.status === 'OK') ok += 1;
    if (meta.stop?.version !== 2 || !Number.isFinite(meta.stop.elapsed_ms) || meta.stop.elapsed_ms < 0
      || meta.recovery_policy?.version !== 1 || !Number.isInteger(meta.recovery_policy.budget_ms)
      || meta.recovery_policy.budget_ms <= 0) timingUnknown += 1;
    else if (meta.stop.elapsed_ms <= meta.recovery_policy.budget_ms) within += 1;
    else over += 1;
  }

  const count = parents.size;
  let value = trials === 0 && parentUnknown === 0
    ? `no manual resume trial of a stalled advise run in the last ${scan.days} days; enabling gate 0/${ENABLING_TRIALS}`
    : `${trials} manual resume trials of stalled advise runs (${count} distinct parents) in the last ${scan.days} days`
      + ` — OK ${ok}, other outcome ${trials - ok}; timing: within budget ${within}, over budget ${over}, unknown ${timingUnknown}`
      + `; enabling gate ${Math.min(count, ENABLING_TRIALS)}/${ENABLING_TRIALS}`
      + (count >= ENABLING_TRIALS
        ? ': gate reached — review every outcome and the shadow watchdog evidence, then decide O8 separately; doctor never enables recovery'
        : `: ${ENABLING_TRIALS - count} more needed`);
  if (parentUnknown) value += `; parent unknown ${parentUnknown}`;
  if (scan.unreadable) value += `, ${scan.unreadable} unreadable records skipped`;
  const unknown = parentUnknown > 0 || timingUnknown > 0;
  if (unknown) value += '; inspect continuations whose parent or timing record could not be read';
  return check('recoveryEnablingGates', unknown ? 'warn' : 'ok', value);
}
