import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { inspectHome } from '../../cli/home-inspection.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

const UUID = '12345678-1234-4123-8123-123456789abc';
const DISPATCHER = '0123456789abcdef0123456789abcdef';

function tree(t) {
  const root = makeTempTree('home-inspection-');
  t.after(() => removeTempTree(root));
  return root;
}

function write(root, relative, content = 'fixture') {
  const filename = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, content);
  return filename;
}

function journal(root) {
  const calls = [];
  const record = (operation, filename) => {
    const relative = path.relative(root, filename).split(path.sep).join('/');
    calls.push({ operation, relative });
  };
  return {
    calls,
    lstat(filename) {
      record('lstat', filename);
      return fs.lstatSync(filename);
    },
    readdir(filename) {
      record('readdir', filename);
      return fs.readdirSync(filename);
    },
  };
}

function emptyLists(result) {
  return [result.files, result.unknown, result.links, result.errors, result.directories];
}

test('missing home returns empty lists', (t) => {
  const root = tree(t);
  const result = inspectHome(path.join(root, 'missing'));
  assert.equal(result.root, 'missing');
  assert.equal(result.rootCode, null);
  assert.deepEqual(emptyLists(result), [[], [], [], [], []]);
});

test('regular file root is ENOTDIR and never walked', (t) => {
  const root = tree(t);
  const filename = write(root, 'file');
  const io = journal(root);
  const result = inspectHome(filename, io);
  assert.equal(result.root, 'error');
  assert.equal(result.rootCode, 'ENOTDIR');
  assert.deepEqual(emptyLists(result), [[], [], [], [], []]);
  assert.deepEqual(io.calls, []);
});

test('root stat errors other than ENOENT are named', (t) => {
  const root = tree(t);
  t.mock.method(fs, 'statSync', () => {
    throw Object.assign(new Error('denied'), { code: 'EACCES' });
  });
  const result = inspectHome(root);
  assert.equal(result.root, 'error');
  assert.equal(result.rootCode, 'EACCES');
  assert.deepEqual(emptyLists(result), [[], [], [], [], []]);
});

test('registry files and image copy temporaries carry exact roles and removal classes', (t) => {
  const root = tree(t);
  const expected = [
    { relative: '.installed.json', id: 'install-record', role: 'primary', removal: 'install-owned' },
    { relative: 'config.json', id: 'config', role: 'primary', removal: 'purge-only' },
    { relative: 'conventions.md', id: 'conventions', role: 'primary', removal: 'purge-only' },
    { relative: `lib/.a.mjs.${UUID}.tmp`, id: 'install-image', role: 'copy-temporary', removal: 'install-owned' },
    { relative: 'lib/a.mjs', id: 'install-image', role: 'primary', removal: 'install-owned' },
    { relative: 'state/diagnostics/order-gate.last.json', id: 'diagnostics', role: 'primary', removal: 'purge-only' },
    { relative: `state/dispatchers/${DISPATCHER}.json`, id: 'dispatcher-state', role: 'primary', removal: 'purge-only' },
    { relative: `state/dispatchers/${DISPATCHER}.json.lock`, id: 'dispatcher-state', role: 'lock', removal: 'purge-only' },
  ];
  for (const entry of [...expected].reverse()) write(root, entry.relative);
  const result = inspectHome(root, { imageMembers: ['lib/a.mjs'] });
  assert.equal(result.root, 'present');
  assert.equal(result.rootCode, null);
  assert.deepEqual(result.files, expected);
  assert.deepEqual(result.unknown, []);
  assert.deepEqual(result.links, []);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.directories, [
    { relative: 'state/diagnostics' },
    { relative: 'state/dispatchers' },
    { relative: 'lib' },
    { relative: 'state' },
  ]);
});

test('unknown files are case-sensitive and unknown folders are not read', (t) => {
  const root = tree(t);
  write(root, 'notes.txt');
  write(root, 'Config.json');
  write(root, 'backups/config.json');
  const io = journal(root);
  const result = inspectHome(root, io);
  assert.deepEqual(result.unknown, [
    { relative: 'Config.json', kind: 'file' },
    { relative: 'backups', kind: 'directory' },
    { relative: 'notes.txt', kind: 'file' },
  ]);
  assert.deepEqual(result.files, []);
  assert.equal(io.calls.some((call) => call.operation === 'readdir' && call.relative === 'backups'), false);
  assert.equal(io.calls.some((call) => call.relative.startsWith('backups/')), false);
});

// D4 needs real Windows junctions: a mock link cannot prove the filesystem boundary.
test('real junctions below the home are named without any call below them', (t) => {
  const root = tree(t);
  const outside = tree(t);
  const sentinel = write(outside, 'config.json', 'outside must stay');
  fs.mkdirSync(path.join(root, 'state'));
  fs.symlinkSync(outside, path.join(root, 'state', 'elsewhere'), 'junction');
  fs.symlinkSync(outside, path.join(root, 'lib'), 'junction');
  const io = journal(root);
  const result = inspectHome(root, { ...io, imageMembers: ['lib/config.json', 'state/elsewhere/config.json'] });
  assert.deepEqual(result.links, [{ relative: 'lib' }, { relative: 'state/elsewhere' }]);
  assert.deepEqual(result.files, []);
  assert.deepEqual(result.unknown, []);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.directories, [{ relative: 'state' }]);
  assert.equal(io.calls.some((call) => call.relative.startsWith('lib/')), false);
  assert.equal(io.calls.some((call) => call.relative.startsWith('state/elsewhere/')), false);
  assert.equal(io.calls.some((call) => call.operation === 'readdir' && call.relative === 'lib'), false);
  assert.equal(io.calls.some((call) => call.operation === 'readdir' && call.relative === 'state/elsewhere'), false);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'outside must stay');
  assert.deepEqual(fs.readdirSync(outside), ['config.json']);
});

test('a root reached through a real junction is trusted and walked normally', (t) => {
  const container = tree(t);
  const home = tree(t);
  write(home, 'config.json');
  write(home, 'state/diagnostics/order-gate.last.json');
  const root = path.join(container, 'home');
  fs.symlinkSync(home, root, 'junction');
  const io = journal(root);
  const result = inspectHome(root, io);
  assert.equal(result.root, 'present');
  assert.deepEqual(result.files.map((entry) => entry.relative), ['config.json', 'state/diagnostics/order-gate.last.json']);
  assert.deepEqual(result.links, []);
  assert.equal(io.calls.some((call) => call.operation === 'lstat' && call.relative === ''), false);
  assert.equal(io.calls.some((call) => call.operation === 'readdir' && call.relative === ''), true);
});

test('lstat permission failures are named, vanished files disappear, and siblings continue', (t) => {
  const root = tree(t);
  write(root, 'config.json');
  write(root, 'conventions.md');
  write(root, '.installed.json');
  const result = inspectHome(root, {
    lstat(filename) {
      if (path.basename(filename) === 'config.json') throw Object.assign(new Error('denied'), { code: 'EACCES' });
      if (path.basename(filename) === 'conventions.md') {
        fs.unlinkSync(filename);
        throw Object.assign(new Error('vanished'), { code: 'ENOENT' });
      }
      return fs.lstatSync(filename);
    },
  });
  assert.deepEqual(result.errors, [{ relative: 'config.json', code: 'EACCES' }]);
  assert.deepEqual(result.files.map((entry) => entry.relative), ['.installed.json']);
  assert.deepEqual(result.unknown, []);
  assert.deepEqual(result.links, []);
  assert.deepEqual(result.directories, []);
  assert.equal(emptyLists(result).flat().some((entry) => entry.relative === 'conventions.md'), false);
});

test('readdir failures retain non-ENOENT findings and skip vanished directories', (t) => {
  const root = tree(t);
  write(root, 'config.json');
  fs.mkdirSync(path.join(root, 'state', 'diagnostics'), { recursive: true });
  fs.mkdirSync(path.join(root, 'state', 'dispatchers'));
  const result = inspectHome(root, {
    readdir(filename) {
      if (path.basename(filename) === 'diagnostics') throw Object.assign(new Error('denied'), { code: 'EACCES' });
      if (path.basename(filename) === 'dispatchers') throw Object.assign(new Error('vanished'), { code: 'ENOENT' });
      return fs.readdirSync(filename);
    },
  });
  assert.deepEqual(result.errors, [{ relative: 'state/diagnostics', code: 'EACCES' }]);
  assert.deepEqual(result.files.map((entry) => entry.relative), ['config.json']);
  assert.deepEqual(result.directories, [{ relative: 'state/diagnostics' }, { relative: 'state' }]);
  assert.equal(emptyLists(result).flat().some((entry) => entry.relative === 'state/dispatchers'), false);
});

test('root readdir errors are named with the empty relative path', (t) => {
  const root = tree(t);
  const result = inspectHome(root, {
    readdir() {
      throw Object.assign(new Error('I/O failure'), { code: 'EIO' });
    },
  });
  assert.equal(result.root, 'present');
  assert.deepEqual(result.errors, [{ relative: '', code: 'EIO' }]);
  assert.deepEqual(result.directories, []);
});

test('non-file entries remain unknown and every lstat error except ENOENT is named', (t) => {
  const root = tree(t);
  write(root, 'socket');
  write(root, 'z-broken');
  write(root, 'a-broken');
  const result = inspectHome(root, {
    lstat(filename) {
      if (path.basename(filename).endsWith('-broken')) throw Object.assign(new Error('I/O failure'), { code: 'EIO' });
      return { isSymbolicLink: () => false, isFile: () => false, isDirectory: () => false };
    },
    readdir(filename) {
      return fs.readdirSync(filename).reverse();
    },
  });
  assert.deepEqual(result.unknown, [{ relative: 'socket', kind: 'other' }]);
  assert.deepEqual(result.errors, [{ relative: 'a-broken', code: 'EIO' }, { relative: 'z-broken', code: 'EIO' }]);
});

test('nested image ancestors are inspected top-down and listed deepest first', (t) => {
  const root = tree(t);
  write(root, 'lib/nested/deep/a.mjs');
  const io = journal(root);
  const result = inspectHome(root, { ...io, imageMembers: ['lib/nested/deep/a.mjs'] });
  const index = (operation, relative) => io.calls.findIndex((call) => call.operation === operation && call.relative === relative);
  assert.deepEqual(result.directories, [{ relative: 'lib/nested/deep' }, { relative: 'lib/nested' }, { relative: 'lib' }]);
  assert.deepEqual(result.files.map((entry) => entry.relative), ['lib/nested/deep/a.mjs']);
  assert.ok(index('lstat', 'lib') < index('readdir', 'lib'));
  assert.ok(index('readdir', 'lib') < index('lstat', 'lib/nested'));
  assert.ok(index('lstat', 'lib/nested') < index('readdir', 'lib/nested'));
  assert.ok(index('readdir', 'lib/nested') < index('lstat', 'lib/nested/deep'));
  assert.ok(index('lstat', 'lib/nested/deep') < index('readdir', 'lib/nested/deep'));
  assert.ok(index('readdir', 'lib/nested/deep') < index('lstat', 'lib/nested/deep/a.mjs'));
});
