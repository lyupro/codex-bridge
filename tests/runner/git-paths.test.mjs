/** Plan_73: the 2026-09-30 Cyrillic incident requires byte-exact git names, never quoted text. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import { listRepositoryPaths } from '../../src/home/lib/runner/git-paths.mjs';
import { validateScope } from '../../src/home/lib/runner/scope-check.mjs';

function fixture(t, suffix) {
  const repo = makeTempTree(`git-paths-${suffix}-`);
  t.after(() => removeTempTree(repo));
  return repo;
}

function mockGit(t, implementation) {
  t.mock.method(childProcess, 'spawnSync', implementation);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

test('git lists exact Cyrillic and leading-space names, tracked and untracked but not ignored', (t) => {
  const repo = fixture(t, 'repository');
  const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(git('init').status, 0);
  assert.equal(git('config', '--local', '--get', 'core.quotepath').status, 1);
  const tracked = 'tracked-и.md';
  const untracked = 'untracked-я.md';
  const leadingSpace = ' leading-space.md';
  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.md\n');
  for (const name of [tracked, untracked, leadingSpace, 'ignored.md']) fs.writeFileSync(path.join(repo, name), 'File.\n');
  assert.equal(git('add', '--', tracked).status, 0);
  assert.deepEqual(listRepositoryPaths(repo).sort(), ['.gitignore', tracked, untracked, leadingSpace].sort());
});

test('NUL parsing preserves quotes, edge spaces, separators, case, line breaks and a leading BOM', (t) => {
  // Windows cannot create quote or trailing-space names normally; feed the exact git bytes instead.
  const names = ['\uFEFFfirst.md', 'areas/tickets-и-notifier.md', ' edge.md ', 'a"b.md', 'UPPER.md', 'a\\b.md', 'a\nb.md'];
  mockGit(t, (command, args, options) => {
    assert.equal(command, 'git');
    assert.deepEqual(args, ['-C', 'repository', 'ls-files', '-z', '--cached', '--others', '--exclude-standard']);
    assert.equal(options.windowsHide, true);
    assert.equal(Object.hasOwn(options, 'shell'), false);
    assert.equal(Object.hasOwn(options, 'encoding'), false);
    return { status: 0, stdout: Buffer.from(`${names.join('\0')}\0`) };
  });
  assert.deepEqual(listRepositoryPaths('repository'), names);
});

test('only an empty trailing record is discarded', (t) => {
  let stdout = Buffer.alloc(0);
  mockGit(t, () => ({ status: 0, stdout }));
  assert.deepEqual(listRepositoryPaths('repository'), []);
  stdout = Buffer.from('a.md\0\0b.md\0');
  assert.deepEqual(listRepositoryPaths('repository'), ['a.md', '', 'b.md']);
  stdout = Buffer.from('last.md');
  assert.deepEqual(listRepositoryPaths('repository'), ['last.md']);
});

test('a non-repository directory returns null', (t) => {
  assert.equal(listRepositoryPaths(fixture(t, 'not-repository')), null);
});

test('failed or absent git returns null', (t) => {
  let result = { status: 1, stdout: Buffer.from('not a listing') };
  mockGit(t, () => result);
  assert.equal(listRepositoryPaths('repository'), null);
  result = { status: null, error: Object.assign(new Error('git absent'), { code: 'ENOENT' }) };
  assert.equal(listRepositoryPaths('repository'), null);
});

test('invalid UTF-8 throws with the repository name and becomes a scope refusal', (t) => {
  const repo = fixture(t, 'invalid-utf8');
  mockGit(t, () => ({ status: 0, stdout: Buffer.from([0x66, 0x80, 0]) }));
  assert.throws(() => listRepositoryPaths(repo), (error) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes(repo));
    assert.match(error.message, /file name that is not UTF-8/);
    return true;
  });
  const refusal = validateScope(repo, ['file.md']);
  assert.equal(refusal.pattern, 'file.md');
  assert.ok(refusal.reason.includes(repo));
  assert.match(refusal.reason, /file name that is not UTF-8/);
  assert.match(refusal.action, /rename.*UTF-8/);
});

test('scope matching keeps git names intact and remains case-insensitive', (t) => {
  const repo = fixture(t, 'matching');
  mockGit(t, () => ({ status: 0, stdout: Buffer.from('"quoted.md"\0edge.md \0UPPER.md\0') }));
  assert.equal(validateScope(repo, ['"quoted.md"', 'edge.md?', 'upper.md']), null);
  for (const pattern of ['quoted.md', 'edge.md']) {
    assert.match(validateScope(repo, [pattern]).reason, /does not match any existing path/);
  }
});
