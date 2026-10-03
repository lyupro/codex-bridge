/** Guards Plan_60 R11's start-content evidence against blaming a run for earlier dirty bytes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import {
  FLAG_BASELINE_VERSION, FLAG_BASELINE_MANIFEST, FLAG_BASELINE_DIR, FLAG_BASELINE_LIMITS,
  captureFlagBaseline, readFlagBaseline, removeFlagBaselineCopies,
} from '../../src/home/lib/runner/flag-baseline.mjs';
import { writeBuildBefore } from '../../src/home/lib/runner/build-evidence.mjs';

const savedEnvironments = new WeakMap();

function environment(t, values) {
  let saved = savedEnvironments.get(t);
  if (!saved) {
    saved = new Map();
    savedEnvironments.set(t, saved);
    t.after(() => {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
  }
  for (const [key, value] of Object.entries(values)) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function fixture(t, { initialize = true, commit = true } = {}) {
  const root = makeTempTree('bridge-flag-baseline-');
  t.after(async () => { await removeTempTree(root); });
  const repoRoot = path.join(root, 'repo');
  const runDir = path.join(root, 'run');
  fs.mkdirSync(repoRoot);
  fs.mkdirSync(runDir);
  environment(t, {
    GIT_CONFIG_GLOBAL: path.join(root, 'absent-config'),
    GIT_CONFIG_SYSTEM: path.join(root, 'absent-config'),
    GIT_CONFIG_COUNT: undefined,
    CODEX_RUNS_ROOT: path.join(root, 'runs'),
  });
  const git = (...args) => {
    const result = spawnSync('git', ['-C', repoRoot, '-c', 'core.autocrlf=false', ...args], {
      encoding: 'utf8', windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const write = (name, content) => fs.writeFileSync(path.join(repoRoot, name), content);
  if (initialize) git('init', '-q');
  if (initialize && commit) {
    write('.gitignore', 'ignored.txt\n');
    for (const name of ['unstaged.txt', 'изменено.txt', 'deleted.txt', 'clean.txt']) write(name, 'start\n');
    git('add', '--', '.gitignore', 'unstaged.txt', 'изменено.txt', 'deleted.txt', 'clean.txt');
    git('-c', 'user.name=Baseline Test', '-c', 'user.email=baseline@example.test',
      '-c', 'commit.gpgsign=false', 'commit', '-qm', 'baseline fixture');
  }
  const capture = (limits = FLAG_BASELINE_LIMITS) => captureFlagBaseline({
    runDir, repoRoot, isGitRepo: initialize, limits,
  });
  return { repoRoot, runDir, git, write, capture };
}

function copyBytes(runDir, entry) {
  return fs.readFileSync(path.join(runDir, FLAG_BASELINE_DIR, entry.copy));
}

test('dirty staged and unstaged bytes, exact names and deletions form a complete sorted baseline', (t) => {
  const { repoRoot, runDir, git, write, capture } = fixture(t);
  const crlf = Buffer.from('earlier\r\nchange\r\n');
  const staged = Buffer.from('staged only\n');
  const untracked = Buffer.from([0xff, 0xfe, 0x61, 0x0a]);
  write('unstaged.txt', crlf);
  write('изменено.txt', staged);
  git('add', '--', 'изменено.txt');
  fs.unlinkSync(path.join(repoRoot, 'deleted.txt'));
  write('new.txt', untracked);
  write('ignored.txt', 'ignored\n');
  const manifest = capture();
  assert.equal(manifest.version, FLAG_BASELINE_VERSION);
  assert.equal(manifest.head, git('rev-parse', 'HEAD').trim());
  assert.equal(manifest.complete, true);
  assert.equal(manifest.reason, '');
  assert.deepEqual(manifest.limits, FLAG_BASELINE_LIMITS);
  assert.deepEqual(manifest.files.map((entry) => entry.path),
    ['deleted.txt', 'new.txt', 'unstaged.txt', 'изменено.txt']);
  assert.deepEqual(manifest.files[0], { path: 'deleted.txt', tracked: true, state: 'deleted' });
  for (const [name, bytes, tracked] of [
    ['new.txt', untracked, false], ['unstaged.txt', crlf, true], ['изменено.txt', staged, true],
  ]) {
    const entry = manifest.files.find((file) => file.path === name);
    assert.equal(entry.tracked, tracked);
    assert.equal(entry.state, 'copied');
    assert.match(entry.copy, /^\d+\.bin$/);
    assert.equal(entry.bytes, bytes.length);
    assert.deepEqual(copyBytes(runDir, entry), bytes);
  }
  assert.deepEqual(readFlagBaseline(runDir), manifest);
  const json = fs.readFileSync(path.join(runDir, FLAG_BASELINE_MANIFEST), 'utf8');
  assert.ok(json.includes('изменено.txt'));
  assert.ok(!json.includes('staged only'));
});

test('a file dirty in both the index and worktree is copied once with its current bytes', (t) => {
  const { git, write, runDir, capture } = fixture(t);
  write('unstaged.txt', 'index\n');
  git('add', '--', 'unstaged.txt');
  write('unstaged.txt', 'working tree\n');
  const manifest = capture();
  assert.equal(manifest.files.length, 1);
  assert.deepEqual(copyBytes(runDir, manifest.files[0]), Buffer.from('working tree\n'));
});

test('oversize start content is explicit and is not copied', (t) => {
  const { runDir, write, capture } = fixture(t);
  write('large.txt', '12345');
  const limits = { perFileBytes: 4, perRunBytes: 100 };
  const manifest = capture(limits);
  assert.deepEqual(manifest.files, [{ path: 'large.txt', tracked: false, state: 'truncated' }]);
  assert.equal(manifest.complete, false);
  assert.equal(manifest.reason, 'some start contents are unknown');
  assert.deepEqual(manifest.limits, limits);
  assert.equal(fs.existsSync(path.join(runDir, FLAG_BASELINE_DIR)), false);
});

test('a NUL in the first 8000 bytes is binary; a later NUL does not prevent a byte copy', (t) => {
  const { runDir, write, capture } = fixture(t);
  write('binary.bin', Buffer.from([1, 0, 2]));
  const tail = Buffer.concat([Buffer.alloc(8000, 65), Buffer.from([0])]);
  write('tail.txt', tail);
  const manifest = capture();
  assert.deepEqual(manifest.files[0], { path: 'binary.bin', tracked: false, state: 'binary' });
  assert.equal(manifest.complete, false);
  assert.equal(manifest.reason, 'some start contents are unknown');
  assert.deepEqual(copyBytes(runDir, manifest.files[1]), tail);
});

test('the sorted second copy exceeds the run cap without consuming bytes', (t) => {
  const { write, runDir, capture } = fixture(t);
  write('a.txt', '1234');
  write('b.txt', '5678');
  write('c.txt', '9');
  const manifest = capture({ perFileBytes: 10, perRunBytes: 5 });
  assert.deepEqual(manifest.files.map((entry) => entry.state), ['copied', 'over-run-cap', 'copied']);
  assert.deepEqual(copyBytes(runDir, manifest.files[0]), Buffer.from('1234'));
  assert.deepEqual(copyBytes(runDir, manifest.files[2]), Buffer.from('9'));
  assert.equal(manifest.complete, false);
  assert.equal(manifest.reason, 'some start contents are unknown');
});

test('an internal run store excludes tracked and untracked artifacts without hiding similar names', (t) => {
  const { repoRoot, git, write } = fixture(t);
  const store = path.join(repoRoot, 'прогоны');
  fs.mkdirSync(store);
  fs.writeFileSync(path.join(store, 'tracked.txt'), 'before\n');
  git('add', '--', 'прогоны/tracked.txt');
  environment(t, { CODEX_RUNS_ROOT: store });
  fs.writeFileSync(path.join(store, 'tracked.txt'), 'artifact\n');
  fs.writeFileSync(path.join(store, 'untracked.txt'), 'artifact\n');
  const runDir = path.join(store, 'current');
  fs.mkdirSync(runDir);
  write('прогоны-other.txt', 'real work\n');
  const manifest = captureFlagBaseline({ runDir, repoRoot, isGitRepo: true });
  assert.deepEqual(manifest.files.map((entry) => entry.path), ['прогоны-other.txt']);
  assert.equal(manifest.complete, true);
});

for (const [initialize, reason] of [[false, 'not a git repository'], [true, 'no start commit']]) {
  test(`${reason} leaves an incomplete manifest and no copies`, (t) => {
    const { runDir, write, capture } = fixture(t, { initialize, commit: false });
    write('new.txt', 'uncommitted\n');
    const manifest = capture();
    assert.equal(manifest.head, '');
    assert.equal(manifest.complete, false);
    assert.equal(manifest.reason, reason);
    assert.deepEqual(manifest.files, []);
    assert.deepEqual(readFlagBaseline(runDir), manifest);
    assert.equal(fs.existsSync(path.join(runDir, FLAG_BASELINE_DIR)), false);
  });
}

test('missing, malformed and unsupported manifests cannot be read', (t) => {
  const { runDir } = fixture(t);
  const full = path.join(runDir, FLAG_BASELINE_MANIFEST);
  assert.equal(readFlagBaseline(runDir), null);
  fs.writeFileSync(full, '{');
  assert.equal(readFlagBaseline(runDir), null);
  fs.writeFileSync(full, JSON.stringify({ version: FLAG_BASELINE_VERSION + 1 }));
  assert.equal(readFlagBaseline(runDir), null);
  fs.writeFileSync(full, 'null');
  assert.equal(readFlagBaseline(runDir), null);
});

test('removing temporary copies preserves the manifest and tolerates an already absent directory', (t) => {
  const { runDir, write, capture } = fixture(t);
  write('new.txt', 'content\n');
  const manifest = capture();
  assert.equal(fs.existsSync(path.join(runDir, FLAG_BASELINE_DIR)), true);
  removeFlagBaselineCopies(runDir);
  assert.equal(fs.existsSync(path.join(runDir, FLAG_BASELINE_DIR)), false);
  assert.deepEqual(readFlagBaseline(runDir), manifest);
  removeFlagBaselineCopies(runDir);
  assert.deepEqual(readFlagBaseline(runDir), manifest);
});

test('an untracked file gone after listing is absent and still complete', (t) => {
  const { repoRoot, write, capture } = fixture(t);
  write('gone.txt', 'content\n');
  const stat = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', function (name, ...args) {
    if (name === path.join(repoRoot, 'gone.txt')) {
      throw Object.assign(new Error('vanished'), { code: 'ENOENT' });
    }
    return stat.call(this, name, ...args);
  });
  const manifest = capture();
  assert.deepEqual(manifest.files, [{ path: 'gone.txt', tracked: false, state: 'absent' }]);
  assert.equal(manifest.complete, true);
});

test('a non-file and a read failure are explicit unknown start contents', (t) => {
  const { repoRoot, write, capture } = fixture(t);
  fs.unlinkSync(path.join(repoRoot, 'deleted.txt'));
  fs.mkdirSync(path.join(repoRoot, 'deleted.txt'));
  write('locked.txt', 'content\n');
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function (name, ...args) {
    if (name === path.join(repoRoot, 'locked.txt')) {
      throw Object.assign(new Error('locked'), { code: 'EACCES' });
    }
    return read.call(this, name, ...args);
  });
  const manifest = capture();
  assert.deepEqual(manifest.files, [
    { path: 'deleted.txt', tracked: true, state: 'unreadable' },
    { path: 'locked.txt', tracked: false, state: 'unreadable' },
  ]);
  assert.equal(manifest.complete, false);
  assert.equal(manifest.reason, 'some start contents are unknown');
});

test('a failed git listing is never treated as a successful empty baseline', (t) => {
  const { capture } = fixture(t);
  environment(t, {
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'diff.algorithm', GIT_CONFIG_VALUE_0: 'invalid-algorithm',
  });
  const manifest = capture();
  assert.equal(manifest.complete, false);
  assert.equal(manifest.reason, 'git listing failed');
  assert.deepEqual(manifest.files, []);
});

test('build-before writes its state evidence before capturing the baseline', (t) => {
  const { repoRoot, runDir, write } = fixture(t);
  write('new.txt', 'start bytes\n');
  const writes = [];
  const writeFile = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', function (name, ...args) {
    writes.push(path.basename(name));
    return writeFile.call(this, name, ...args);
  });
  writeBuildBefore({ runDir, repoRoot, isGitRepo: true });
  assert.deepEqual(writes.slice(0, 4), ['head-before.txt', 'branch-before.txt', 'git-before.txt', 'state-before.txt']);
  assert.equal(writes.at(-1), FLAG_BASELINE_MANIFEST);
  assert.equal(readFlagBaseline(runDir).files[0].path, 'new.txt');
});
