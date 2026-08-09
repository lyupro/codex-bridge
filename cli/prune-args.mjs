/** Parses prune scopes and refuses combinations that could widen destructive reach. */
import path from 'node:path';

const DURATION = /^(\d+)([dh])$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function error(message) {
  return { error: `codex-bridge prune: ${message}` };
}

function validCalendarDate(value) {
  const match = DATE.exec(value);
  if (!match) return false;
  const [, year, month, day] = match;
  const timestamp = Date.UTC(Number(year), Number(month) - 1, Number(day));
  const date = new Date(timestamp);
  return date.getUTCFullYear() === Number(year)
    && date.getUTCMonth() === Number(month) - 1
    && date.getUTCDate() === Number(day);
}

/** Parses 30d, 12h, or a calendar date without consulting the filesystem. */
export function parseOlderThan(value) {
  const text = String(value ?? '').trim();
  const duration = DURATION.exec(text);
  if (duration) {
    const amount = Number(duration[1]);
    if (amount > 0 && Number.isSafeInteger(amount)) {
      return { kind: 'duration', amount, unit: duration[2] };
    }
  }
  if (validCalendarDate(text)) return { kind: 'date', date: text };
  return { error: `--older-than must be a positive duration like 30d or 12h, or an exact date YYYY-MM-DD; got "${text}"` };
}

function validateName(label, value) {
  if (!value || value === '.' || value === '..' || path.isAbsolute(value) || path.dirname(value) !== '.') {
    return error(`${label} must be a bare folder name`);
  }
  return null;
}

/** Parses prune's positional scopes and safety flags. */
export function parsePruneArgs(argv = []) {
  const positional = [];
  let allProjects = false;
  let purge = false;
  let force = false;
  let json = false;
  let olderThan = null;
  let olderThanExplicit = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--all-projects') {
      allProjects = true;
      continue;
    }
    if (arg === '--purge') {
      purge = true;
      continue;
    }
    if (arg === '--force' || arg === '-f') {
      force = true;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--older-than' || arg === '--older-than=') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-')) return error('--older-than requires a value');
      const parsed = parseOlderThan(value);
      if (parsed.error) return error(parsed.error.replace(/^--older-than\s*/, '--older-than '));
      olderThan = parsed;
      olderThanExplicit = true;
      index += 1;
      continue;
    }
    if (arg.startsWith('--older-than=')) {
      const value = arg.slice('--older-than='.length);
      if (!value) return error('--older-than requires a value');
      const parsed = parseOlderThan(value);
      if (parsed.error) return error(parsed.error.replace(/^--older-than\s*/, '--older-than '));
      olderThan = parsed;
      olderThanExplicit = true;
      continue;
    }
    if (arg.startsWith('-')) return error(`unknown option "${arg}"`);
    positional.push(arg);
  }

  if (allProjects && purge) {
    return error('--all-projects cannot be combined with --purge; all-projects is gentle only');
  }
  if (allProjects && positional.length) {
    return error('--all-projects does not accept a project or run name');
  }
  if (!allProjects && (positional.length < 1 || positional.length > 2)) {
    return error('expected <project>, optional <run>, or --all-projects');
  }

  const projectName = positional[0] || null;
  const runName = positional[1] || null;
  if (projectName) {
    const invalid = validateName('project', projectName);
    if (invalid) return invalid;
  }
  if (runName) {
    const invalid = validateName('run', runName);
    if (invalid) return invalid;
  }

  // The 30-day default belongs to the gentle cleanup, which searches history for weight to shed.
  // A purge is never implicitly aged: `prune sbx2 --purge` means that folder, now. Defaulting it
  // made the plan's own fourth scenario unreachable — a young project answered "nothing to
  // remove", which reads as a broken command, not as a refusal.
  if (!olderThan && !purge && (allProjects || !runName)) {
    olderThan = { kind: 'duration', amount: 30, unit: 'd' };
  }

  return {
    allProjects,
    projectName,
    runName,
    purge,
    force,
    json,
    olderThan,
    olderThanExplicit,
  };
}
