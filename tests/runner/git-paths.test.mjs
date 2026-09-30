/** Plan_73: the 2026-09-30 Cyrillic incident requires byte-exact git names, never quoted text. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import { listRepositoryPaths, listUntrackedPaths, numstatRows, diffNames, commitNames, porcelainPaths } from '../../src/home/lib/runner/git-paths.mjs';
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

function initializedRepository(t, suffix) {
  const repo = fixture(t, suffix);
  const git = (...args) => {
    const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  git('init');
  assert.equal(spawnSync('git', ['-C', repo, 'config', '--local', '--get', 'core.quotepath'], {
    windowsHide: true,
  }).status, 1);
  const commit = () => git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Fixture');
  return { repo, git, commit };
}

test('untracked listing returns exact Cyrillic names and excludes tracked and ignored files', (t) => {
  const { repo, git } = initializedRepository(t, 'untracked');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored-я.md\n');
  for (const name of ['tracked-и.md', ' untracked-я.md', 'ignored-я.md']) {
    fs.writeFileSync(path.join(repo, name), 'File.\n');
  }
  git('add', '--', '.gitignore', 'tracked-и.md');
  assert.deepEqual(listUntrackedPaths(repo), [' untracked-я.md']);
});

test('numstat returns string counters and exact Cyrillic names for text and binary changes', (t) => {
  const { repo, git, commit } = initializedRepository(t, 'numstat');
  const text = 'текст-я.md';
  const binary = 'данные-и.bin';
  fs.writeFileSync(path.join(repo, text), 'old\n');
  fs.writeFileSync(path.join(repo, binary), Buffer.from([0, 1, 2]));
  git('add', '--', text, binary);
  commit();
  fs.writeFileSync(path.join(repo, text), 'new\nextra\n');
  fs.writeFileSync(path.join(repo, binary), Buffer.from([0, 3, 4]));
  assert.deepEqual(numstatRows(repo).sort((a, b) => a.path.localeCompare(b.path)), [
    { added: '-', deleted: '-', path: binary },
    { added: '2', deleted: '1', path: text },
  ].sort((a, b) => a.path.localeCompare(b.path)));
});

test('name-only listing preserves Cyrillic names for diff ranges and show commits', (t) => {
  const { repo, git, commit } = initializedRepository(t, 'name-only');
  const name = ' имя-я.md';
  fs.writeFileSync(path.join(repo, name), 'old\n');
  git('add', '--', name);
  commit();
  fs.writeFileSync(path.join(repo, name), 'new\n');
  git('add', '--', name);
  commit();
  const sha = git('rev-parse', 'HEAD').trim();
  assert.deepEqual(diffNames(repo, 'HEAD~1..HEAD'), [name]);
  assert.deepEqual(commitNames(repo, sha), [name]);
});

test('porcelain listing includes both exact Cyrillic names of a staged rename', (t) => {
  const { repo, git, commit } = initializedRepository(t, 'porcelain');
  const source = ' старое-я.md';
  const destination = ' новое-и.md';
  fs.writeFileSync(path.join(repo, source), 'File.\n');
  git('add', '--', source);
  commit();
  git('mv', '--', source, destination);
  assert.deepEqual(porcelainPaths(repo), [destination, source]);
});

test('each added listing uses exact argv, Buffer output, windowsHide and no shell', (t) => {
  const names = ['\uFEFFfirst.md', ' имя-я.md ', 'a"b.md', 'UPPER.md', 'a\\b.md', 'a\nb\tc.md'];
  const diffArgs = ['diff', '--name-only', '-z', 'base..head'];
  const showArgs = ['show', '--name-only', '--format=', '-z', 'sha'];
  const rows = names.map((name) => ({ added: '12', deleted: '0', path: name }));
  const cases = [
    { call: () => listUntrackedPaths('repository'), args: ['ls-files', '-z', '-o', '--exclude-standard'],
      output: `${names.join('\0')}\0`, expected: names },
    { call: () => numstatRows('repository'), args: ['diff', 'HEAD', '--numstat', '--no-renames', '-z'],
      output: `${names.map((name) => `12\t0\t${name}`).join('\0')}\0`, expected: rows },
    { call: () => diffNames('repository', 'base..head'), args: diffArgs,
      output: `${names.join('\0')}\0`, expected: names },
    { call: () => commitNames('repository', 'sha'), args: showArgs,
      output: `${names.join('\0')}\0`, expected: names },
    { call: () => porcelainPaths('repository'), args: ['status', '--porcelain', '-z'],
      output: `${names.map((name) => `?? ${name}`).join('\0')}\0`, expected: names },
  ];
  let current;
  let calls = 0;
  mockGit(t, (command, args, options) => {
    calls += 1;
    assert.equal(command, 'git');
    assert.deepEqual(args, ['-C', 'repository', ...current.args]);
    assert.equal(options.windowsHide, true);
    assert.equal(Object.hasOwn(options, 'shell'), false);
    assert.equal(Object.hasOwn(options, 'encoding'), false);
    return { status: 0, stdout: Buffer.from(current.output) };
  });
  for (current of cases) assert.deepEqual(current.call(), current.expected);
  assert.equal(calls, cases.length);
});

test('porcelain consumes rename and copy sources in either status column, deduplicating in order', (t) => {
  mockGit(t, () => ({ status: 0, stdout: Buffer.from(
    'R  renamed-я.md\0 source-и.md \0 R renamed-я.md\0second-source.md\0'
    + 'C  copy.md\0 source-и.md \0 C other-copy.md\0?? source.md\0?? tail.md\0',
  ) }));
  assert.deepEqual(porcelainPaths('repository'), [
    'renamed-я.md', ' source-и.md ', 'second-source.md', 'copy.md', 'other-copy.md', '?? source.md', 'tail.md',
  ]);
});

test('each added listing returns null when git fails or is absent, and [] for empty success', (t) => {
  let result;
  mockGit(t, () => result);
  const calls = [
    () => listUntrackedPaths('repository'), () => numstatRows('repository'),
    () => diffNames('repository', 'HEAD'),
    () => porcelainPaths('repository'),
  ];
  for (result of [
    { status: 1, stdout: Buffer.from('not a listing') },
    { status: null, error: Object.assign(new Error('git absent'), { code: 'ENOENT' }) },
  ]) {
    for (const call of calls) assert.equal(call(), null);
  }
  result = { status: 0, stdout: Buffer.alloc(0) };
  for (const call of calls) assert.deepEqual(call(), []);
});

test('each listing rejects invalid UTF-8 with the shared error code', (t) => {
  mockGit(t, () => ({ status: 0, stdout: Buffer.from([0x66, 0x80, 0]) }));
  const calls = [
    () => listRepositoryPaths('repository'), () => listUntrackedPaths('repository'),
    () => numstatRows('repository'),
    () => diffNames('repository', 'HEAD'),
    () => porcelainPaths('repository'),
  ];
  for (const call of calls) {
    assert.throws(call, (error) => {
      assert.equal(error.code, 'ERR_GIT_PATH_NOT_UTF8');
      assert.ok(error.message.includes('repository'));
      assert.ok(error.cause instanceof TypeError);
      return true;
    });
  }
});

