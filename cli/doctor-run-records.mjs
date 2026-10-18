/**
 * Scans run records once for doctor evidence because four doctor lines must judge
 * the same records (Plan_80 E19).
 */
import fs from 'node:fs';
import path from 'node:path';
import { readJsonFileSync } from '../src/home/lib/json-file.mjs';

const RUN_TIME = /^(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})(\d{2})/;
const DAY_MS = 24 * 60 * 60 * 1000;

export function scanRunRecords({ runsRoot, now = Date.now(), days = 30 }) {
  let projects;
  try {
    projects = fs.readdirSync(runsRoot, { withFileTypes: true });
  } catch (error) {
    return { error: `runs root unavailable: ${error.message}` };
  }

  const windowEnd = new Date(now).getTime();
  const windowStart = windowEnd - days * DAY_MS;
  const records = [];
  let unreadable = 0;
  let statusUnreadable = 0;
  for (const project of projects) {
    if (project.name === '.git' || !project.isDirectory()) continue;
    let runs;
    try {
      runs = fs.readdirSync(path.join(runsRoot, project.name), { withFileTypes: true });
    } catch (error) {
      return { error: `runs root scan unavailable: ${error.message}` };
    }
    for (const run of runs) {
      if (run.name === '.git' || !run.isDirectory()) continue;
      const time = RUN_TIME.exec(run.name);
      if (!time) continue;
      const timestamp = new Date(`${time[1]}T${time[2]}:${time[3]}:${time[4]}`).getTime();
      if (!Number.isFinite(timestamp) || timestamp < windowStart || timestamp > windowEnd) continue;
      const runDir = path.join(runsRoot, project.name, run.name);
      let meta;
      try {
        meta = readJsonFileSync(path.join(runDir, 'meta.json'));
      } catch (error) {
        // Live or abandoned runs can lack metadata; Plan_80 E12 does not count those as damage.
        if (error.code !== 'ENOENT') unreadable += 1;
        continue;
      }
      let status = null;
      try {
        status = readJsonFileSync(path.join(runDir, 'status.json'));
      } catch {
        statusUnreadable += 1;
      }
      records.push({ project: project.name, run: run.name, runDir, status, meta });
    }
  }
  return { records, unreadable, statusUnreadable, days, windowStart, windowEnd };
}
