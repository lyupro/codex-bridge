/** Owns read-only sandbox log evidence and repair formatting after 2026-10-10 TradeForge orders exposed only "setup refresh had errors". */
import fs from 'node:fs';
import path from 'node:path';

const LOG_LIMIT = 64 * 1024;
const SETUP_LIMIT = 8 * 1024;
const ERROR_LINE = /setup error|setup refresh completed with errors|failed|error/i;
// A successful refresh logs `errors=[]`; on the 2026-10-10 log five of them pushed the real error out.
const CLEAN_REFRESH = /errors=\[\]/;
const NO_REPAIR = 'No verified repair signature; inspect this log.';

// Plan_78 A1: a repair needs all incident fragments on one fresh line, not a generic error word.
const SIGNATURES = Object.freeze([
  Object.freeze({
    id: 'runtime-file-locked',
    observed: Object.freeze({ date: '2026-10-10', codexCli: '0.162.1' }),
    predicate: (line) => ['runtime read/execute validation failed',
      'open ACL target for root-only update', 'os error 32'].every((fragment) => line.includes(fragment)),
    summary: 'A file under the Codex runtimes folder is held open by another process, so sandbox setup cannot update its access rights (openai/codex #51634).',
    repair: () => 'Find and close the process holding the file named in the line (on 2026-10-10, the Codex desktop app\'s computer-use helper), then rerun codex-bridge doctor; on Codex CLI 0.162.x the proven workaround is npm install -g @openai/codex@0.160.1.',
  }),
  Object.freeze({
    id: 'deny-read-state-corrupt',
    observed: Object.freeze({ date: '2026-09-16' }),
    predicate: (line) => ['deny_read_acl_state.json', 'expected value at line 1 column 1']
      .every((fragment) => line.includes(fragment)),
    summary: 'The sandbox state file is empty or corrupt.',
    repair: (codexHome) => `Back up and rename ${path.join(codexHome, '.sandbox', 'deny_read_acl_state.json')}, then rerun codex-bridge doctor; the helper recreates it.`,
  }),
]);

function logPath(codexHome, date) {
  const day = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')].join('-');
  return path.join(codexHome, '.sandbox', `sandbox.${day}.log`);
}

function fileSize(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? stat.size : null;
  } catch (error) {
    // Only ENOENT proves absence; permission failures must not become a zero-byte baseline.
    return error.code === 'ENOENT' ? 0 : null;
  }
}

function readRange(file, start, limit, tail) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return { state: 'unknown' };
    const offset = tail ? Math.max(start, stat.size - limit) : start;
    const length = Math.min(limit, Math.max(0, stat.size - offset));
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const count = fs.readSync(fd, buffer, read, length - read, offset + read);
      if (count === 0) break;
      read += count;
    }
    let text = buffer.subarray(0, read).toString('utf8');
    // A capped tail can begin inside a signature; that fragment is not a complete error line.
    if (tail && offset > start) {
      const newline = text.indexOf('\n');
      text = newline < 0 ? '' : text.slice(newline + 1);
    }
    return { state: 'read', text, bytes: read, size: stat.size, mtime: stat.mtimeMs };
  } catch (error) {
    return { state: error.code === 'ENOENT' ? 'missing' : 'unknown' };
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* Evidence collection must not hide the dead-probe refusal. */ }
    }
  }
}

function readSetupError(file) {
  const result = readRange(file, 0, SETUP_LIMIT, false);
  return {
    state: result.state,
    text: result.state === 'read' ? result.text : result.state === 'missing' ? null
      : `Unknown: unable to read ${file}.`,
  };
}

export function snapshotSandboxLogs({ codexHome, now = new Date() }) {
  const previous = new Date(now);
  // Local calendar arithmetic survives DST; subtracting 24 hours can choose the wrong day.
  previous.setDate(previous.getDate() - 1);
  return {
    logs: [now, previous].map((date) => {
      const file = logPath(codexHome, date);
      return { path: file, size: fileSize(file) };
    }),
    setupError: readSetupError(path.join(codexHome, '.sandbox', 'setup_error.json')),
  };
}

export function diagnoseSandbox({ codexHome, before, now = new Date() }) {
  const baselines = new Map(before.logs.map((log) => [log.path, log.size]));
  const paths = [...new Set([...baselines.keys(), logPath(codexHome, now)])].sort();
  const sources = [];
  const appended = [];
  const recent = [];
  const unknown = [];
  let attributed = false;
  for (const file of paths) {
    const baseline = baselines.has(file) ? baselines.get(file) : 0;
    const result = readRange(file, baseline ?? 0, LOG_LIMIT, true);
    if (result.state === 'missing') continue;
    sources.push(file);
    if (result.state === 'unknown') {
      unknown.push(`Unknown: unable to read ${file}.`);
      continue;
    }
    if (baseline !== null && result.bytes > 0) {
      attributed = true;
      appended.push(result.text);
    }
    recent.push({ file, mtime: result.mtime });
    if (baseline === null) unknown.push(`Unknown: pre-probe size unavailable for ${file}.`);
  }

  let text = appended.join('\n');
  if (!attributed && recent.length) {
    const newest = recent.sort((a, b) => b.mtime - a.mtime || b.file.localeCompare(a.file))[0];
    const fallback = readRange(newest.file, 0, LOG_LIMIT, true);
    if (fallback.state === 'read') text = fallback.text;
    else unknown.push(`Unknown: unable to read ${newest.file}.`);
  }
  const errors = text.split(/\r?\n/)
    .filter((line) => ERROR_LINE.test(line) && !CLEAN_REFRESH.test(line)).slice(-5);
  const match = attributed && [...errors].reverse()
    .map((line) => SIGNATURES.find((signature) => signature.predicate(line))).find(Boolean);
  const setupPath = path.join(codexHome, '.sandbox', 'setup_error.json');
  const setup = readSetupError(setupPath);
  if (setup.state !== 'missing') sources.push(setupPath);
  return {
    codexHome, sources, attributed,
    lines: [...errors, ...unknown].map((line) => line.slice(0, 400)),
    setupError: {
      text: setup.text,
      changed: setup.state === 'unknown' || before.setupError.state === 'unknown'
        ? null : setup.text !== before.setupError.text,
    },
    signature: match ? { id: match.id, summary: match.summary, repair: match.repair(codexHome) } : null,
  };
}

export function formatSandboxDiagnosis(diagnosis) {
  return [
    ...diagnosis.sources.map((source) => `Sandbox diagnosis source: ${source}`),
    diagnosis.attributed ? 'Sandbox log lines attributed to this probe:'
      : 'Recent sandbox log lines only; not attributed to this probe:',
    ...diagnosis.lines.map((line) => `> ${line}`),
    ...(diagnosis.setupError.text === null ? [] : [
      `setup_error.json changed since snapshot: ${diagnosis.setupError.changed === null
        ? 'unknown' : diagnosis.setupError.changed ? 'yes' : 'no'}`,
      ...diagnosis.setupError.text.split(/\r?\n/).map((line) => `> ${line}`),
    ]),
    ...(diagnosis.signature ? [diagnosis.signature.summary, diagnosis.signature.repair] : [NO_REPAIR]),
  ];
}
