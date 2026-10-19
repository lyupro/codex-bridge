/**
 * Publishes a JSON record whole or not at all: a temporary file in the target's directory renamed over it.
 *
 * Plan_62 B2 wrote this twice, once per state module; two copies of one write discipline drift apart the
 * first time either is fixed. Callers hold their own lock — this does not serialize concurrent writers
 * (`config-edit.mjs` keeps its own compare-and-swap publish for that reason).
 * OW-067 / Plan_81: flush before replacement and clean up only owned temporaries to preserve whole records.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function ignoreFailure(action) {
  try {
    action();
  } catch {
    // OW-067: a secondary close or cleanup error must never replace the publication error.
  }
}

function flushDirectory(directory, operations) {
  let descriptor;
  try {
    descriptor = operations.openDirectory(directory, 'r');
    operations.fsync(descriptor);
    operations.close(descriptor);
    return true;
  } catch {
    // Plan_81 D2: the replacement is already visible; a durability failure cannot roll it back.
    if (descriptor !== undefined) ignoreFailure(() => operations.close(descriptor));
    return false;
  }
}

export function publishJsonAtomic(file, record, operations) {
  const contents = `${JSON.stringify(record, null, 2)}\n`;
  const directory = path.dirname(file);
  operations.mkdir(directory, { recursive: true });

  let temporary;
  let descriptor;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    temporary = `${file}.${randomUUID()}.tmp`;
    try {
      descriptor = operations.open(temporary, 'wx');
      break;
    } catch (error) {
      // OW-067: exclusive-create collisions belong to another writer, including the last collision.
      if (error?.code !== 'EEXIST' || attempt === 2) throw error;
    }
  }

  try {
    operations.write(descriptor, contents);
    operations.fsync(descriptor);
    // A failed close still releases the number; closing it again could hit a descriptor reused meanwhile.
    const owned = descriptor;
    descriptor = undefined;
    operations.close(owned);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        operations.rename(temporary, file);
        break;
      } catch (error) {
        if (!['EPERM', 'EBUSY'].includes(error?.code) || attempt === 4) throw error;
        // Plan_81 D2: Windows replacement can be briefly blocked by another process holding the file.
        operations.sleep(20 * (2 ** attempt));
      }
    }
  } catch (error) {
    if (descriptor !== undefined) ignoreFailure(() => operations.close(descriptor));
    ignoreFailure(() => operations.unlink(temporary));
    throw error;
  }

  // Node cannot flush a directory on Windows; do not try and disguise the platform limitation as a failure.
  return { directoryFlushed: operations.platform !== 'win32' && flushDirectory(directory, operations) };
}

function writeText(descriptor, text) {
  const bytes = Buffer.from(text, 'utf8');
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(descriptor, bytes, offset, bytes.length - offset);
    if (written === 0) throw new Error('Atomic JSON write made no progress');
    offset += written;
  }
}

const descriptorOperations = {
  write: writeText,
  fsync(descriptor) { return fs.fsyncSync(descriptor); },
  close(descriptor) { return fs.closeSync(descriptor); },
  openDirectory(directory, flags) { return fs.openSync(directory, flags); },
  sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); },
  platform: process.platform,
};

export function writeHomeJsonAtomic(writer, id, file, record) {
  // Plan_65 B2: `state/` is shared by artifacts, so validate the file before mkdir can create it.
  writer.assertArtifact(id, file);
  return publishJsonAtomic(file, record, {
    ...descriptorOperations,
    mkdir(directory, options) { return writer.mkdirSync(id, directory, options); },
    open(temporary, flags) { return writer.openSync(id, temporary, flags); },
    rename(temporary, target) { return writer.renameSync(id, temporary, target); },
    unlink(temporary) { return writer.unlinkSync(id, temporary); },
  });
}

export function writeRunJsonAtomic(file, record) {
  return publishJsonAtomic(file, record, {
    ...descriptorOperations,
    mkdir(directory, options) { return fs.mkdirSync(directory, options); },
    open(temporary, flags) { return fs.openSync(temporary, flags); },
    rename(temporary, target) { return fs.renameSync(temporary, target); },
    unlink(temporary) { return fs.unlinkSync(temporary); },
  });
}
