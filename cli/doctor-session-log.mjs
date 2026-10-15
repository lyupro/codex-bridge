/**
 * The doctor row that checks the host's newest Codex session log against the package's reader.
 * Plan_80 E11: synthetic fixtures freeze one format; a Codex update can leave them green
 * while real logs stop being recognized. Checking this host exposes drift before stall recovery.
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveCodexHome } from '../src/home/lib/codex-home.mjs';
import { readSessionActivity } from '../src/home/lib/codex-session-log.mjs';
import { check } from './doctor-format.mjs';

const ROLLOUT = /^rollout-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})\.jsonl$/i;

function entries(folder) {
  try {
    return fs.readdirSync(folder, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function folders(folder, pattern) {
  return entries(folder).filter((entry) => entry.isDirectory() && pattern.test(entry.name))
    .map((entry) => entry.name).sort().reverse();
}

function newestRollout(codexHome) {
  const sessions = path.join(codexHome, 'sessions');
  // E11: descend newest-first, skipping empty date folders without recursively scanning the store.
  for (const year of folders(sessions, /^\d{4}$/)) {
    const yearDir = path.join(sessions, year);
    for (const month of folders(yearDir, /^(0[1-9]|1[0-2])$/)) {
      const monthDir = path.join(yearDir, month);
      for (const day of folders(monthDir, /^(0[1-9]|[12]\d|3[01])$/)) {
        const name = entries(path.join(monthDir, day))
          .filter((entry) => entry.isFile() && ROLLOUT.test(entry.name))
          .map((entry) => entry.name).sort().reverse()[0];
        if (name) return name;
      }
    }
  }
  return null;
}

export function sessionLogCheck({ codexHome = resolveCodexHome(), now } = {}) {
  let file;
  try {
    file = newestRollout(codexHome);
  } catch (error) {
    return check('sessionLog', 'warn', error.message);
  }
  if (!file) return check('sessionLog', 'warn', 'no Codex session log on this host yet');

  const [, date, hour, minute, second, threadId] = ROLLOUT.exec(file);
  // doctor's `now` is a time value (cli/active-hosts.mjs); the reader takes a clock function.
  const activity = readSessionActivity({
    threadId, startedAt: `${date}T${hour}:${minute}:${second}`, codexHome,
    now: now === undefined ? undefined : () => new Date(now),
  });
  if (activity.state === 'observed' || activity.state === 'incomplete') {
    let value = `recognized: ${file}, ${activity.records} records, last ${activity.last_record_kind} at ${activity.last_record_at}`;
    if (activity.state === 'incomplete') value += '; last line still being written';
    if (activity.unknown_kinds.length) value += `; new record kinds: ${activity.unknown_kinds.join(', ')}`;
    return check('sessionLog', 'ok', value);
  }
  if (activity.state === 'unrecognized') {
    return check('sessionLog', 'warn', `format not recognized: ${activity.reason}; automatic recovery will treat this host's session logs as unknown evidence`);
  }
  if (activity.state === 'empty') return check('sessionLog', 'warn', `empty Codex session log: ${file}`);
  return check('sessionLog', 'warn', activity.reason ?? `Codex session log ${activity.state}: ${file}`);
}
