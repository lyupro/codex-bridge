/** Implements the projects command. */
import { listProjectRuns, listProjects } from './runs-inventory.mjs';
import { renderTable } from './table.mjs';

// The table renders whatever it is given; how a byte count or a timestamp reads is this command's
// business. Raw bytes and ISO milliseconds are technically exact and practically unreadable — an
// inventory exists to be scanned by eye, and 8468429 has to be counted digit by digit.
const SIZE_UNITS = [['GB', 1024 ** 3], ['MB', 1024 ** 2], ['KB', 1024]];

function formatSize(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return null;
  for (const [unit, scale] of SIZE_UNITS) {
    if (bytes >= scale) return `${(bytes / scale).toFixed(bytes >= 10 * scale ? 0 : 1)} ${unit}`;
  }
  return `${bytes} B`;
}

const pad = (value) => String(value).padStart(2, '0');

/**
 * Both timestamp shapes in the store, printed on one clock. A run folder is named in local time
 * (`2026-08-07_144243`); `meta.finished_at` is an ISO stamp in UTC. Reading the ISO one with a
 * regular expression printed its UTC hours in the same column as local ones, and the 2026-08-07
 * live check (Plan_17-1 §1) saw the run whose folder says `144243` listed as `12:46` — the
 * operator's own zone offset, looking exactly like a different run. Slicing a timestamp is cheaper
 * than parsing it only until the value carries a zone. The folder name stays text because it is
 * already local; parsing it would invent a zone it never had.
 */
function formatStamp(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const folder = /^(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})/.exec(value);
  if (folder) return `${folder[1]} ${folder[2]}:${folder[3]}`;
  const moment = Date.parse(value);
  if (Number.isNaN(moment)) return value;
  const at = new Date(moment);
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
    + ` ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

const PROJECT_COLUMNS = [
  { key: 'project', header: 'project', truncate: 'start' },
  { key: 'runs', header: 'runs', kind: 'number' },
  { key: 'size', header: 'size', kind: 'number', value: (row) => formatSize(row.size) },
  { key: 'totalTokens', header: 'total tokens', kind: 'number' },
  { key: 'liveNow', header: 'live now', kind: 'number' },
  { key: 'lastRun', header: 'last run', kind: 'date', value: (row) => formatStamp(row.lastRun) },
];

// The verdict is never shortened, for the same reason numbers and dates are not: it is one whole
// word from a known set, and half of it is not half an answer. A narrow terminal turned `running`
// into `…nning`, which reads as damage rather than as a run in flight. The agent column keeps the
// tail because that is exactly what tells `codex-build` from `codex-scout`.
const RUN_COLUMNS = [
  { key: 'run', header: 'run', truncate: 'start' },
  { key: 'agent', header: 'agent', truncate: 'start' },
  { key: 'verdict', header: 'verdict', fixed: true },
  { key: 'tokens', header: 'tokens', kind: 'number' },
  { key: 'size', header: 'size', kind: 'number', value: (row) => formatSize(row.size) },
];

function parseArgs(args) {
  const positional = [];
  let json = false;
  for (const arg of args) {
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg.startsWith('-')) return { error: `codex-bridge projects: unknown option "${arg}"` };
    positional.push(arg);
  }
  if (positional.length > 1) {
    return { error: 'codex-bridge projects accepts at most one project name.' };
  }
  return { json, projectName: positional[0] || null };
}

function output(rows, columns, options) {
  if (options.json) return JSON.stringify(rows, null, 2);
  return renderTable(columns, rows, options.terminalWidth);
}

/** Lists projects or runs for one project. */
export function projects(argv = [], options = {}) {
  const parsed = parseArgs(argv);
  if (parsed.error) return { exitCode: 2, output: parsed.error };

  const { projectName } = parsed;
  const root = options.runsRootPath;
  const renderOptions = { json: parsed.json, terminalWidth: options.terminalWidth };

  if (projectName) {
    const rows = listProjectRuns(root, projectName);
    if (rows === null) {
      return {
        exitCode: 1,
        output: `codex-bridge projects: unknown project "${projectName}"`,
      };
    }
    return { exitCode: 0, output: output(rows, RUN_COLUMNS, renderOptions) };
  }

  const rows = listProjects(root);
  return { exitCode: 0, output: output(rows, PROJECT_COLUMNS, renderOptions) };
}
