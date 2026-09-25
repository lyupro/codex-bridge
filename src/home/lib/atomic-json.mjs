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

function removeIfPresent(remove, temporary) {
  try {
    remove(temporary);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function publishJsonAtomic(file, record, operations) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    operations.mkdir(path.dirname(file), { recursive: true });
    operations.write(temporary, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
    operations.rename(temporary, file);
  } finally {
    removeIfPresent(operations.unlink, temporary);
  }
}

export function writeJsonAtomic(file, record) {
  return publishJsonAtomic(file, record, {
    mkdir(directory, options) { return fs.mkdirSync(directory, options); },
    write(temporary, contents, options) { return fs.writeFileSync(temporary, contents, options); },
    rename(temporary, target) { return fs.renameSync(temporary, target); },
    unlink(temporary) { return fs.unlinkSync(temporary); },
  });
}

export function writeHomeJsonAtomic(writer, id, file, record) {
  // Plan_65 B2: `state/` is shared by artifacts, so validate the file before mkdir can create it.
  writer.assertArtifact(id, file);
  return publishJsonAtomic(file, record, {
    mkdir(directory, options) { return writer.mkdirSync(id, directory, options); },
    write(temporary, contents, options) { return writer.writeFileSync(id, temporary, contents, options); },
    rename(temporary, target) { return writer.renameSync(id, temporary, target); },
    unlink(temporary) { return writer.unlinkSync(id, temporary); },
  });
}
