/** Reads the host version from the transcript tail after the 2026-09-25 PATH host identity incident. */
import fs from 'node:fs/promises';
import { parseJsonText } from './json-file.mjs';

export async function transcriptHostVersion(transcriptPath, { tailBytes = 65536 } = {}) {
  try {
    const handle = await fs.open(transcriptPath, 'r');
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, tailBytes);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      const lines = buffer.toString('utf8').split(/\r?\n/);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
          const entry = parseJsonText(transcriptPath, lines[index]);
          if (typeof entry?.version === 'string' && /^\d+\.\d+\.\d+/.test(entry.version)) {
            return entry.version;
          }
        } catch {}
      }
    } finally {
      await handle.close();
    }
  } catch {}
  return null;
}
