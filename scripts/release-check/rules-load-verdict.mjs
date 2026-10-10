/** Judges and records project-core evidence because Plan_64 D12/D13 and the 2026-10-10 manual run cannot count inherited user rules as release proof. */
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export const DEFAULT_ATTEMPT_PATH = 'docs/audits/release-checks/rules-load-claude.json';

function normalizedPath(value) {
  if (typeof value !== 'string' || !value) return null;
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function judgeCell({ witness, expectedPath, frozenSha256, sessionId, transcriptVersion, preflightVersion, invariant }) {
  if (invariant) return { outcome: 'failed', reason: invariant };
  if (witness?.corrupt) return { outcome: 'failed', reason: 'Load witness is corrupt.' };
  const sessions = witness?.sessions;
  const session = sessions && Object.hasOwn(sessions, sessionId) ? sessions[sessionId] : undefined;
  const expected = normalizedPath(expectedPath);
  const load = expected && Array.isArray(session?.loads)
    ? session.loads.find((entry) => entry?.loadReason === 'session_start' && normalizedPath(entry.path) === expected)
    : undefined;
  // Advice A6 in D12: absence of the exact project event cannot prove a load failure.
  if (!load) return { outcome: 'inconclusive', reason: 'No session_start witness for the expected project core in this session.' };
  if (load.sha256 !== frozenSha256) return { outcome: 'failed', reason: 'Project-core witness SHA-256 differs from the frozen SHA-256.' };
  if (!transcriptVersion) return { outcome: 'inconclusive', reason: 'Transcript host version is missing.' };
  if (transcriptVersion !== preflightVersion) {
    return { outcome: 'inconclusive', reason: 'Transcript host version differs from the preflight version.' };
  }
  return { outcome: 'verified', reason: 'Project-core session_start witness matches the frozen SHA-256 and preflight host version.' };
}

export function exitCodeFor(cells) {
  const entries = Array.isArray(cells) ? cells : Object.values(cells);
  if (entries.some((cell) => cell.outcome === 'failed')) return 1;
  if (entries.length < 2 || entries.some((cell) => cell.outcome === 'inconclusive')) return 2;
  return 0;
}

export async function writeAttempt({ file, attempt }) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(attempt, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, file);
  } finally {
    try {
      await unlink(temporary);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}
