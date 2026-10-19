import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHomeWriter } from '../src/home/lib/home-write.mjs';
import { publishJsonAtomic, writeHomeJsonAtomic, writeRunJsonAtomic } from '../src/home/lib/atomic-json.mjs';
import { withTempTree } from './temp-tree.mjs';

function assertNoTemporary(directory) {
  assert.equal(fs.readdirSync(directory).some((name) => name.endsWith('.tmp')), false);
}

test('the home atomic writer publishes through its artifact id and removes its temporary', async () => {
  await withTempTree('atomic-json-home-', async (tree) => {
    const root = path.join(tree, 'home');
    const writer = createHomeWriter({ root });
    const file = path.join(root, 'state', 'handback-witness.json');
    const record = { host: 'codex', seen: true };
    writeHomeJsonAtomic(writer, 'handback-witness', file, record);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), record);
    assertNoTemporary(path.dirname(file));
  });
});

test('a failed home rename rethrows and removes its temporary', async () => {
  await withTempTree('atomic-json-home-rename-', async (tree) => {
    const root = path.join(tree, 'home');
    const writer = createHomeWriter({ root });
    const file = path.join(root, 'state', 'handback-witness.json');
    fs.mkdirSync(file, { recursive: true });
    assert.throws(() => writeHomeJsonAtomic(writer, 'handback-witness', file, { whole: true }));
    assertNoTemporary(path.dirname(file));
  });
});

test('the home atomic writer rejects a mismatched id before creating the parent', async () => {
  await withTempTree('atomic-json-wrong-id-', async (tree) => {
    const root = path.join(tree, 'home');
    const writer = createHomeWriter({ root });
    const file = path.join(root, 'state', 'handback-witness.json');
    assert.throws(
      () => writeHomeJsonAtomic(writer, 'host-observations', file, { wrong: true }),
      { code: 'EHOMEREGISTRY' },
    );
    assert.throws(() => fs.statSync(path.join(root, 'state')), { code: 'ENOENT' });
  });
});

const oldBytes = '{"previous":true}\n';
const nextRecord = { whole: true, text: '你好 🌍' };
const nextBytes = `${JSON.stringify(nextRecord, null, 2)}\n`;
const fault = (code) => Object.assign(new Error(code), { code });

function publicationRig(platform = 'win32') {
  const file = path.join('runs', 'run-1', 'status.json');
  const files = new Map([[file, oldBytes]]);
  const descriptors = new Map();
  const trace = [];
  let nextDescriptor = 0;
  const operations = {
    platform,
    mkdir(directory, options) { trace.push(['mkdir', directory, options]); },
    open(temporary, flags) {
      trace.push(['open', temporary, flags]);
      assert.equal(flags, 'wx');
      if (files.has(temporary)) throw fault('EEXIST');
      files.set(temporary, '');
      const descriptor = nextDescriptor++;
      descriptors.set(descriptor, temporary);
      return descriptor;
    },
    write(descriptor, text) {
      trace.push(['write', descriptor, text]);
      assert.ok(descriptors.has(descriptor));
      files.set(descriptors.get(descriptor), text);
    },
    fsync(descriptor) {
      trace.push(['fsync', descriptor]);
      assert.ok(descriptors.has(descriptor));
    },
    close(descriptor) {
      trace.push(['close', descriptor]);
      assert.ok(descriptors.delete(descriptor));
    },
    rename(temporary, target) {
      trace.push(['rename', temporary, target]);
      assert.equal(descriptors.size, 0);
      assert.ok(files.has(temporary));
      files.set(target, files.get(temporary));
      files.delete(temporary);
    },
    unlink(temporary) {
      trace.push(['unlink', temporary]);
      assert.notEqual(temporary, file);
      files.delete(temporary);
    },
    openDirectory(directory, flags) {
      trace.push(['openDirectory', directory, flags]);
      assert.equal(directory, path.dirname(file));
      assert.equal(flags, 'r');
      descriptors.set('directory', directory);
      return 'directory';
    },
    sleep(ms) { trace.push(['sleep', ms]); },
  };
  return { file, files, descriptors, trace, operations };
}

function assertPublished(rig, bytes, foreign = []) {
  assert.equal(rig.files.get(rig.file), bytes);
  assert.deepEqual([...rig.files.entries()].filter(([file]) => file !== rig.file), foreign);
  assert.equal(rig.descriptors.size, 0);
}

function failOnce(rig, operation, error) {
  const original = rig.operations[operation];
  let failed = false;
  rig.operations[operation] = (...args) => {
    if (!failed) {
      failed = true;
      rig.trace.push([operation, ...args]);
      // close(2) releases the descriptor even when it reports an error; model that, not a leak.
      if (operation === 'close') rig.descriptors.delete(args[0]);
      throw error;
    }
    return original(...args);
  };
}

test('publication writes, flushes and closes the whole UTF-8 record before replacing the target', () => {
  const rig = publicationRig();
  assert.deepEqual(publishJsonAtomic(rig.file, nextRecord, rig.operations), { directoryFlushed: false });
  assertPublished(rig, nextBytes);
  const temporary = rig.trace[1][1];
  assert.deepEqual(rig.trace, [
    ['mkdir', path.dirname(rig.file), { recursive: true }],
    ['open', temporary, 'wx'], ['write', 0, nextBytes], ['fsync', 0], ['close', 0],
    ['rename', temporary, rig.file],
  ]);
  assert.ok(temporary.startsWith(`${rig.file}.`));
  assert.ok(temporary.endsWith('.tmp'));
});

for (const collisions of [1, 3]) {
  test(`${collisions} exclusive-create collision(s) never remove another writer's temporary`, () => {
    const rig = publicationRig();
    const open = rig.operations.open;
    const foreign = [];
    const error = fault('EEXIST');
    rig.operations.open = (temporary, flags) => {
      if (foreign.length < collisions) {
        foreign.push([temporary, 'another writer']);
        rig.files.set(temporary, 'another writer');
      }
      try {
        return open(temporary, flags);
      } catch {
        throw error;
      }
    };
    if (collisions === 3) {
      assert.throws(() => publishJsonAtomic(rig.file, nextRecord, rig.operations), (caught) => caught === error);
    } else {
      publishJsonAtomic(rig.file, nextRecord, rig.operations);
    }
    assertPublished(rig, collisions === 3 ? oldBytes : nextBytes, foreign);
    const opens = rig.trace.filter(([name]) => name === 'open');
    assert.equal(opens.length, collisions === 3 ? 3 : 2);
    assert.equal(new Set(opens.map(([, temporary]) => temporary)).size, opens.length);
    assert.equal(rig.trace.some(([name]) => name === 'unlink'), false);
  });
}

test('an exclusive-create error other than EEXIST throws immediately without cleanup', () => {
  const rig = publicationRig();
  const error = fault('EACCES');
  failOnce(rig, 'open', error);
  assert.throws(() => publishJsonAtomic(rig.file, nextRecord, rig.operations), (caught) => caught === error);
  assertPublished(rig, oldBytes);
  assert.deepEqual(rig.trace.map(([name]) => name), ['mkdir', 'open']);
});

for (const operation of ['write', 'fsync', 'close']) {
  for (const cleanupFails of [false, true]) {
    test(`${operation} failure preserves its original error${cleanupFails ? ' even when cleanup also fails' : ''}`, () => {
      const rig = publicationRig();
      const error = fault(`original-${operation}`);
      failOnce(rig, operation, error);
      if (cleanupFails) {
        const unlink = rig.operations.unlink;
        rig.operations.unlink = (temporary) => {
          unlink(temporary);
          throw fault('secondary-cleanup');
        };
      }
      assert.throws(() => publishJsonAtomic(rig.file, nextRecord, rig.operations), (caught) => caught === error);
      assertPublished(rig, oldBytes);
      const temporary = rig.trace.find(([name]) => name === 'open')[1];
      assert.deepEqual(rig.trace.filter(([name]) => name === 'unlink'), [['unlink', temporary]]);
      assert.equal(rig.trace.some(([name]) => name === 'rename'), false);
      // A failed close is never repeated: its descriptor number may already belong to someone else.
      assert.equal(rig.trace.filter(([name]) => name === 'close').length, 1);
    });
  }
}

test('a recovery close error cannot replace the original write error', () => {
  const rig = publicationRig();
  const error = fault('original-write');
  failOnce(rig, 'write', error);
  const close = rig.operations.close;
  rig.operations.close = (descriptor) => {
    close(descriptor);
    throw fault('secondary-close');
  };
  assert.throws(() => publishJsonAtomic(rig.file, nextRecord, rig.operations), (caught) => caught === error);
  assertPublished(rig, oldBytes);
  assert.deepEqual(rig.trace.map(([name]) => name), ['mkdir', 'open', 'write', 'close', 'unlink']);
});

function failRenames(rig, errors) {
  const rename = rig.operations.rename;
  rig.operations.rename = (temporary, target) => {
    if (errors.length) {
      rig.trace.push(['rename', temporary, target]);
      throw errors.shift();
    }
    return rename(temporary, target);
  };
}

test('EPERM twice retries replacement with 20 and 40 ms pauses, then publishes', () => {
  const rig = publicationRig();
  failRenames(rig, [fault('EPERM'), fault('EPERM')]);
  publishJsonAtomic(rig.file, nextRecord, rig.operations);
  assertPublished(rig, nextBytes);
  assert.equal(rig.trace.filter(([name]) => name === 'rename').length, 3);
  assert.deepEqual(rig.trace.filter(([name]) => name === 'sleep'), [['sleep', 20], ['sleep', 40]]);
});

test('five EBUSY errors exhaust replacement retries and preserve the destination', () => {
  const rig = publicationRig();
  const errors = Array.from({ length: 5 }, () => fault('EBUSY'));
  const lastError = errors[4];
  failRenames(rig, errors);
  assert.throws(() => publishJsonAtomic(rig.file, nextRecord, rig.operations), (caught) => caught === lastError);
  assertPublished(rig, oldBytes);
  assert.equal(rig.trace.filter(([name]) => name === 'rename').length, 5);
  assert.deepEqual(rig.trace.filter(([name]) => name === 'sleep'), [
    ['sleep', 20], ['sleep', 40], ['sleep', 80], ['sleep', 160],
  ]);
  assert.deepEqual(rig.trace.at(-1), ['unlink', rig.trace[1][1]]);
});

test('EACCES from replacement is not retried even if cleanup fails', () => {
  const rig = publicationRig();
  const error = fault('EACCES');
  failRenames(rig, [error]);
  const unlink = rig.operations.unlink;
  rig.operations.unlink = (temporary) => {
    unlink(temporary);
    throw fault('secondary-cleanup');
  };
  assert.throws(() => publishJsonAtomic(rig.file, nextRecord, rig.operations), (caught) => caught === error);
  assertPublished(rig, oldBytes);
  assert.equal(rig.trace.filter(([name]) => name === 'rename').length, 1);
  assert.equal(rig.trace.some(([name]) => name === 'sleep'), false);
});

test('Linux flushes the parent directory only after replacement', () => {
  const rig = publicationRig('linux');
  assert.deepEqual(publishJsonAtomic(rig.file, nextRecord, rig.operations), { directoryFlushed: true });
  assertPublished(rig, nextBytes);
  assert.deepEqual(rig.trace.slice(-4), [
    ['rename', rig.trace[1][1], rig.file],
    ['openDirectory', path.dirname(rig.file), 'r'], ['fsync', 'directory'], ['close', 'directory'],
  ]);
});

for (const operation of ['openDirectory', 'fsync', 'close']) {
  test(`Linux directory ${operation} failure reports reduced durability without undoing publication`, () => {
    const rig = publicationRig('linux');
    const original = rig.operations[operation];
    let failed = false;
    rig.operations[operation] = (...args) => {
      if (!failed && (operation === 'openDirectory' || args[0] === 'directory')) {
        failed = true;
        rig.trace.push([operation, ...args]);
        throw fault('directory-flush');
      }
      return original(...args);
    };
    assert.deepEqual(publishJsonAtomic(rig.file, nextRecord, rig.operations), { directoryFlushed: false });
    assertPublished(rig, nextBytes);
    assert.equal(failed, true);
    assert.equal(rig.trace.some(([name]) => name === 'unlink'), false);
  });
}

test('Windows explicitly skips opening the parent directory', () => {
  const rig = publicationRig('win32');
  assert.deepEqual(publishJsonAtomic(rig.file, nextRecord, rig.operations), { directoryFlushed: false });
  assertPublished(rig, nextBytes);
  assert.equal(rig.trace.some(([name]) => name === 'openDirectory'), false);
});

test('serialization failure precedes mkdir and exclusive create', () => {
  const rig = publicationRig();
  assert.throws(() => publishJsonAtomic(rig.file, { invalid: 1n }, rig.operations), TypeError);
  assertPublished(rig, oldBytes);
  assert.deepEqual(rig.trace, []);
});

test('the run atomic writer creates and replaces real JSON records without leaving temporaries', async () => {
  await withTempTree('atomic-json-run-', async (tree) => {
    const file = path.join(tree, 'runs', 'run-1', 'meta.json');
    const firstRecord = { previous: true };
    writeRunJsonAtomic(file, firstRecord);
    assert.equal(fs.readFileSync(file, 'utf8'), `${JSON.stringify(firstRecord, null, 2)}\n`);
    assertNoTemporary(path.dirname(file));
    const result = writeRunJsonAtomic(file, nextRecord);
    assert.equal(fs.readFileSync(file, 'utf8'), nextBytes);
    assert.equal(typeof result.directoryFlushed, 'boolean');
    if (process.platform === 'win32') assert.equal(result.directoryFlushed, false);
    assertNoTemporary(path.dirname(file));
  });
});
