/**
 * Serialize, validate and compare worktree snapshots; owns the version rule.
 *
 * On 2026-09-30 git's quoted Cyrillic names made an in-scope edit look out of scope
 * and hid a new Cyrillic file. JSON names preserve exact spelling; mixed versions
 * must refuse comparison rather than repeat that incident.
 */
export const SNAPSHOT_V2_HEADER = '# codex-bridge-state-v2';

const STATE_RE = /^(?:\d+\t\d+|-\t-|U\t(?:\d+:[0-9a-fA-F]{64}|missing))$/;
const LEGACY_ROW_RE = /^(?:\d+\t\d+|-\t-|U\t\d+)\t\S.*$/;
const validState = (state) => typeof state === 'string' && STATE_RE.exec(state)?.[0] === state;
const malformed = (detail) => ({ ok: false, issue: 'malformed', detail });

export function encodeSnapshot(rows) {
  const paths = new Set();
  const ordered = [];
  for (const row of rows) {
    if (!row || typeof row.path !== 'string' || !validState(row.state)) {
      throw new TypeError('Snapshot rows require a string path and a valid v2 state.');
    }
    if (paths.has(row.path)) throw new TypeError(`Duplicate snapshot path: ${JSON.stringify(row.path)}`);
    paths.add(row.path);
    ordered.push({ path: row.path, state: row.state });
  }
  ordered.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return [SNAPSHOT_V2_HEADER, ...ordered.map(({ path, state }) => `${state}\t${JSON.stringify(path)}`)]
    .join('\n') + '\n';
}

export function decodeSnapshot(text) {
  if (text === null) return { ok: false, issue: 'missing', detail: 'Snapshot file is absent.' };
  if (typeof text !== 'string') return malformed('Snapshot text must be a string or null.');
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const version = lines[0] === SNAPSHOT_V2_HEADER ? 2 : 1;
  if (version === 2) lines.shift();
  // Only the final line terminator is framing; an empty interior row is damaged data.
  if (lines.at(-1) === '') lines.pop();
  const rows = new Map();
  for (const [index, line] of lines.entries()) {
    const location = `Snapshot line ${index + (version === 2 ? 2 : 1)}`;
    let path;
    let state;
    if (version === 2) {
      const fields = line.split('\t');
      if (fields.length !== 3) return malformed(`${location} must have exactly three tab fields.`);
      state = `${fields[0]}\t${fields[1]}`;
      if (!validState(state)) return malformed(`${location} has an invalid v2 state.`);
      try {
        path = JSON.parse(fields[2]);
      } catch {
        return malformed(`${location} has an invalid JSON path.`);
      }
      if (typeof path !== 'string') return malformed(`${location} path must be a JSON string.`);
    } else {
      if (!LEGACY_ROW_RE.test(line)) return malformed(`${location} has an invalid legacy row.`);
      const fields = line.split('\t');
      state = `${fields[0]}\t${fields[1]}`;
      path = fields.slice(2).join('\t').trim();
      if (path.startsWith('"')) {
        return {
          ok: false,
          issue: 'legacy-quoted-name',
          detail: `${location} contains a git-quoted legacy name whose original spelling is lost.`,
        };
      }
    }
    if (rows.has(path)) return malformed(`${location} repeats path ${JSON.stringify(path)}.`);
    rows.set(path, state);
  }
  return { ok: true, version, rows };
}

export function compareSnapshots(beforeText, afterText) {
  const before = decodeSnapshot(beforeText);
  if (!before.ok) return { ...before, side: 'before' };
  const after = decodeSnapshot(afterText);
  if (!after.ok) return { ...after, side: 'after' };
  if (before.version !== after.version) {
    return {
      ok: false,
      issue: 'incompatible-versions',
      detail: 'The run started under another package version; restart the run before comparing snapshots.',
    };
  }
  const changed = [];
  for (const [path, state] of after.rows) if (before.rows.get(path) !== state) changed.push(path);
  for (const path of before.rows.keys()) if (!after.rows.has(path)) changed.push(path);
  return { ok: true, changed };
}
