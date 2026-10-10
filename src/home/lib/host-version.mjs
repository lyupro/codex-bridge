/** Reads the host version from a session transcript after the 2026-09-25 PATH host identity incident. */
import fs from 'node:fs/promises';
import { parseJsonText } from './json-file.mjs';

const VERSION = /^\d+\.\d+\.\d+/;

function versionIn(transcriptPath, lines, sessionId, newestFirst) {
  const order = newestFirst ? [...lines.keys()].reverse() : lines.keys();
  for (const index of order) {
    try {
      const entry = parseJsonText(transcriptPath, lines[index]);
      // Plan_64 D11: a neighboring session's version cannot identify this load witness.
      if (sessionId && entry?.sessionId !== sessionId) continue;
      if (typeof entry?.version === 'string' && VERSION.test(entry.version)) return entry.version;
    } catch {}
  }
  return null;
}

async function slice(handle, position, length) {
  const buffer = Buffer.alloc(length);
  await handle.read(buffer, 0, length, position);
  return buffer.toString('utf8').split(/\r?\n/);
}

/**
 * A live session's newest lines name its host, so the tail answers the shell-command observers. A finished session
 * may end in a 135 KB attachment line and metadata without `version` (B6b live run, 2026-10-10), so a named session is
 * also looked up from the head: one session runs on one host, and its first user line already carries the version.
 */
export async function transcriptHostVersion(transcriptPath, { tailBytes = 65536, headBytes = 1048576, sessionId } = {}) {
  const session = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
  try {
    const handle = await fs.open(transcriptPath, 'r');
    try {
      const { size } = await handle.stat();
      const tailLength = Math.min(size, tailBytes);
      const fromTail = versionIn(transcriptPath, await slice(handle, size - tailLength, tailLength), session, true);
      if (fromTail !== null || !session) return fromTail;
      return versionIn(transcriptPath, await slice(handle, 0, Math.min(size, headBytes)), session, false);
    } finally {
      await handle.close();
    }
  } catch {}
  return null;
}
