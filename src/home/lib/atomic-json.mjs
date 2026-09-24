/**
 * Publishes a JSON record whole or not at all: a temporary file in the target's directory renamed over it.
 *
 * Plan_62 B2 wrote this twice, once per state module; two copies of one write discipline drift apart the
 * first time either is fixed. Callers hold their own lock — this does not serialize concurrent writers
 * (`config-edit.mjs` keeps its own compare-and-swap publish for that reason).
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function writeJsonAtomic(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
