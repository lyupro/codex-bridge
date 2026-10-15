/**
 * Reports whether successful runs have outgrown their frozen silence threshold.
 * Plan_80 E12: the threshold ships with the package, so calibration drift must be
 * visible on the host before it misclassifies a healthy run as stalled.
 */
import fs from 'node:fs';
import path from 'node:path';
import { check } from './doctor-format.mjs';
import { readJsonFileSync } from '../src/home/lib/json-file.mjs';

const RUN_TIME = /^(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})(\d{2})/;
const DAY_MS = 24 * 60 * 60 * 1000;
const RECALIBRATE = '; recalibrate: measure the longest quiet pause of successful runs from Codex session logs and change the threshold together with its evidence in silence-policy.mjs, then release';

export function silenceCalibrationCheck({ runsRoot, now = Date.now(), days = 30 }) {
  let projects;
  try {
    projects = fs.readdirSync(runsRoot, { withFileTypes: true });
  } catch (error) {
    return check('silenceCalibration', 'warn', `runs root unavailable: ${error.message}`);
  }

  const end = new Date(now).getTime();
  const start = end - days * DAY_MS;
  const groups = new Map();
  let skipped = 0;
  for (const project of projects) {
    if (project.name === '.git' || !project.isDirectory()) continue;
    let runs;
    try {
      runs = fs.readdirSync(path.join(runsRoot, project.name), { withFileTypes: true });
    } catch (error) {
      return check('silenceCalibration', 'warn', `runs root scan unavailable: ${error.message}`);
    }
    for (const run of runs) {
      if (run.name === '.git' || !run.isDirectory()) continue;
      const time = RUN_TIME.exec(run.name);
      if (!time) continue;
      const timestamp = new Date(`${time[1]}T${time[2]}:${time[3]}:${time[4]}`).getTime();
      if (!Number.isFinite(timestamp) || timestamp < start || timestamp > end) continue;
      let meta;
      try {
        meta = readJsonFileSync(path.join(runsRoot, project.name, run.name, 'meta.json'));
      } catch (error) {
        // A run still in progress, or abandoned before collect, has no record yet: that is not
        // an unreadable record, and counting it would make every live run look like damage.
        if (error.code !== 'ENOENT') skipped += 1;
        continue;
      }
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
  }

  const breached = [...groups.values()].some((group) => group.breaches > 0);
  let value = groups.size ? [...groups.keys()].sort().map((key) => {
    const group = groups.get(key);
    const thresholds = [...group.thresholds].sort((a, b) => a - b).join('/');
    return `${key}: ${group.breaches} of ${group.count} successful runs reached ${thresholds} ms (longest quiet pause ${group.longest} ms)`;
  }).join('; ') : `no successful run with recorded pauses in the last ${days} days`;
  if (breached) value += RECALIBRATE;
  if (skipped) value += `, ${skipped} unreadable records skipped`;
  return check('silenceCalibration', breached ? 'warn' : 'ok', value);
}
