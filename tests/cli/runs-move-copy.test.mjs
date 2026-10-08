/** Plan_77 D1/D3: preserve every byte and exact name, and roll back only our failed copy. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { copyRunStore, sha256File } from '../../cli/runs-move-copy.mjs';
import { withTempTree } from '../temp-tree.mjs';

function snapshot(root) {
  const entries = {};
  function walk(relative) {
    for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
      const child = path.join(relative, name);
      const file = path.join(root, child);
      if (fs.lstatSync(file).isDirectory()) {
        entries[child] = 'directory';
        walk(child);
      } else entries[child] = fs.readFileSync(file).toString('hex');
    }
  }
  walk('');
  return entries;
}

function fixture(root) {
  const from = path.join(root, 'source');
  const to = path.join(root, 'source-copy');
  fs.mkdirSync(path.join(from, 'project', 'empty'), { recursive: true });
  fs.writeFileSync(path.join(from, 'project', 'events.jsonl'), Buffer.from([0, 1, 255, 10]));
  fs.writeFileSync(path.join(from, '.project.json'), '{}');
  return { from, to };
}

test('nested copy preserves empty folders, bytes and verbatim dot/space names', async (t) => {
  await withTempTree('runs-move-copy-', (root) => {
    const { from, to } = fixture(root);
    // The operator's 2026-10-08 Windows probe means no sanitizing the historical phrase name.
    const oddFolder = process.platform === 'win32' ? 'tradeforge.loc (do not cd into codex-runs).' : 'project ';
    const oddFile = process.platform === 'win32' ? 'reply.' : 'reply ';
    fs.mkdirSync(path.join(from, oddFolder));
    fs.writeFileSync(path.join(from, oddFolder, oddFile), 'reply');
    fs.mkdirSync(to);
    const before = snapshot(from);
    const flags = [];
    const copy = fs.copyFileSync;
    t.mock.method(fs, 'copyFileSync', (src, dst, flag) => { flags.push(flag); return copy(src, dst, flag); });
    assert.deepEqual(copyRunStore({ from, to }), { files: 3, directories: 3, bytes: 11 });
    assert.deepEqual(snapshot(to), before);
    assert.deepEqual(snapshot(from), before);
    assert.ok(flags.every((flag) => flag === fs.constants.COPYFILE_EXCL));
    assert.ok(fs.readdirSync(to).includes(oddFolder));
    assert.deepEqual(fs.readdirSync(path.join(to, oddFolder)), [oddFile]);
  });
});

test('an existing empty destination is accepted and an empty source remains empty', async () => {
  await withTempTree('runs-move-empty-', (root) => {
    const from = path.join(root, 'source');
    const to = path.join(root, 'copy');
    fs.mkdirSync(from);
    fs.mkdirSync(to);
    assert.deepEqual(copyRunStore({ from, to }), { files: 0, directories: 0, bytes: 0 });
    assert.deepEqual(fs.readdirSync(from), []);
    assert.deepEqual(fs.readdirSync(to), []);
  });
});

test('non-empty and file destinations are refused without writing', async (t) => {
  await withTempTree('runs-move-destination-', (root) => {
    const { from, to } = fixture(root);
    fs.mkdirSync(to);
    fs.writeFileSync(path.join(to, 'operator-data'), 'keep');
    const file = path.join(root, 'not-a-directory');
    fs.writeFileSync(file, 'keep file');
    const before = snapshot(root);
    t.mock.method(fs, 'mkdirSync', () => assert.fail('preflight must not write'));
    t.mock.method(fs, 'copyFileSync', () => assert.fail('preflight must not copy'));
    t.mock.method(fs, 'rmSync', () => assert.fail('preflight must not remove'));
    for (const destination of [to, file]) {
      assert.throws(() => copyRunStore({ from, to: destination }), (error) => {
        assert.ok(error.message.includes(destination));
        return /not an empty directory/.test(error.message);
      });
    }
    assert.deepEqual(snapshot(root), before);
  });
});

test('equal, nested and containing paths are refused after normalization before writes', async (t) => {
  await withTempTree('runs-move-overlap-', (root) => {
    const { from } = fixture(root);
    const before = snapshot(root);
    t.mock.method(fs, 'mkdirSync', () => assert.fail('overlap must not write'));
    t.mock.method(fs, 'copyFileSync', () => assert.fail('overlap must not copy'));
    t.mock.method(fs, 'rmSync', () => assert.fail('overlap must not remove'));
    const destinations = [from, path.join(from, 'copy'), root, path.join(from, 'project', '..')];
    if (process.platform === 'win32') destinations.push(from.toUpperCase());
    for (const to of destinations) assert.throws(() => copyRunStore({ from, to }), /paths overlap/);
    assert.deepEqual(snapshot(root), before);
  });
});

test('source and destination symlinks are refused without following them', async (t) => {
  await withTempTree('runs-move-symlink-', (root) => {
    const { from, to } = fixture(root);
    const target = path.join(root, 'target');
    const link = path.join(from, 'linked');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'private'), 'untouched');
    try {
      fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (!['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(error.code)) throw error;
      t.skip(`This platform cannot create a symlink: ${error.code}`);
      return;
    }
    assert.throws(() => copyRunStore({ from, to }), (error) => error.message.includes(link));
    assert.equal(fs.existsSync(to), false);
    assert.equal(fs.readFileSync(path.join(target, 'private'), 'utf8'), 'untouched');
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.throws(() => copyRunStore({ from: link, to }), /Unsupported run store entry/);
    assert.throws(() => copyRunStore({ from: target, to: link }), /not an empty directory/);
  });
});

test('special entries are refused by lstat before writing', async (t) => {
  await withTempTree('runs-move-special-', (root) => {
    const { from, to } = fixture(root);
    const special = path.join(from, '.project.json');
    const lstat = fs.lstatSync;
    t.mock.method(fs, 'lstatSync', (file, ...args) => file === special
      ? { isSymbolicLink: () => false, isFile: () => false, isDirectory: () => false }
      : lstat(file, ...args));
    assert.throws(() => copyRunStore({ from, to }), (error) => error.message.includes(special));
    assert.equal(fs.existsSync(to), false);
    assert.equal(fs.readFileSync(special, 'utf8'), '{}');
  });
});

for (const existing of [false, true]) {
  test(`a differing injected hash removes the ${existing ? 'initially empty' : 'new'} copy, never the source`, async () => {
    await withTempTree('runs-move-hash-', (root) => {
      const { from, to } = fixture(root);
      fs.mkdirSync(to); // F1: both cases use staging created exclusively by the caller.
      const before = snapshot(from);
      const badFile = path.join(to, 'project', 'events.jsonl');
      assert.throws(() => copyRunStore({ from, to, hash: (file) => file === badFile ? 'different' : sha256File(file) }),
        /events\.jsonl/);
      assert.equal(fs.existsSync(to), false);
      assert.deepEqual(snapshot(from), before);
    });
  });
}

for (const failure of ['size', 'hash', 'extra-file', 'extra-empty-folder', 'missing-file', 'missing-empty-folder']) {
  test(`verification catches ${failure} and cleans only the copy`, async (t) => {
    await withTempTree('runs-move-verify-', (root) => {
      const { from, to } = fixture(root);
      fs.mkdirSync(to);
      const before = snapshot(from);
      const copy = fs.copyFileSync;
      t.mock.method(fs, 'copyFileSync', (src, dst, flags) => {
        copy(src, dst, flags);
        if (path.basename(src) !== 'events.jsonl') return;
        if (failure === 'size') fs.appendFileSync(dst, 'extra');
        if (failure === 'hash') fs.writeFileSync(dst, 'xxxx');
        if (failure === 'extra-file') fs.writeFileSync(path.join(to, 'unexpected'), 'extra');
        if (failure === 'extra-empty-folder') fs.mkdirSync(path.join(to, 'unexpected'));
        if (failure === 'missing-file') fs.unlinkSync(dst);
        if (failure === 'missing-empty-folder') fs.rmdirSync(path.join(to, 'project', 'empty'));
      });
      const expected = failure.startsWith('extra') ? /unexpected/
        : failure === 'missing-empty-folder' ? /empty/ : /events\.jsonl/;
      assert.throws(() => copyRunStore({ from, to }), expected);
      assert.equal(fs.existsSync(to), false);
      assert.deepEqual(snapshot(from), before);
    });
  });
}

test('copy failures roll back partial files and keep the original bytes', async (t) => {
  await withTempTree('runs-move-copy-error-', (root) => {
    const { from, to } = fixture(root);
    fs.mkdirSync(to);
    const before = snapshot(from);
    const copy = fs.copyFileSync;
    t.mock.method(fs, 'copyFileSync', (src, dst, flags) => {
      if (path.basename(src) === 'events.jsonl') throw new Error(`Cannot copy ${src}`);
      return copy(src, dst, flags);
    });
    assert.throws(() => copyRunStore({ from, to }), /events\.jsonl/);
    assert.equal(fs.existsSync(to), false);
    assert.deepEqual(snapshot(from), before);
  });
});

test('sha256File hashes large logs in 1 MiB chunks and closes the descriptor', async (t) => {
  await withTempTree('runs-move-stream-', (root) => {
    const file = path.join(root, 'large.log');
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 37, 123);
    fs.writeFileSync(file, bytes);
    const read = fs.readSync;
    const lengths = [];
    t.mock.method(fs, 'readSync', (descriptor, buffer, offset, length, position) => {
      lengths.push(length);
      return read(descriptor, buffer, offset, length, position);
    });
    const close = t.mock.method(fs, 'closeSync');
    assert.equal(sha256File(file), createHash('sha256').update(bytes).digest('hex'));
    assert.equal(lengths.length, 4);
    assert.ok(lengths.every((length) => length === 1024 * 1024));
    assert.equal(close.mock.callCount(), 1);
  });
});

// Plan_77 F1: copying must never create or claim an unowned destination.
test('copy requires the caller to have created staging and leaves absent staging absent', async () => {
  await withTempTree('runs-move-no-staging-', (root) => {
    const { from, to } = fixture(root);
    const before = snapshot(from);
    assert.throws(() => copyRunStore({ from, to }), /staging folder must already exist/);
    assert.equal(fs.existsSync(to), false);
    assert.deepEqual(snapshot(from), before);
  });
});
