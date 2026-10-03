/** Guards Plan_60 R12a: only this run's added marker lines are advisory flags. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import childProcess, { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import { worktreeSnapshot } from '../../src/home/lib/runner/git-state.mjs';
import {
  captureFlagBaseline, readFlagBaseline, FLAG_BASELINE_DIR, FLAG_BASELINE_MANIFEST,
} from '../../src/home/lib/runner/flag-baseline.mjs';
import { isFlagLine, scanRunFlags } from '../../src/home/lib/runner/flag-scan.mjs';

function fixture(t) {
  const repoRoot = makeTempTree('bridge-flag-scan-repo-');
  const runDir = makeTempTree('bridge-flag-scan-run-');
  t.after(async () => {
    await removeTempTree(repoRoot);
    await removeTempTree(runDir);
  });
  const environment = {
    GIT_CONFIG_GLOBAL: path.join(runDir, 'absent-config'),
    GIT_CONFIG_SYSTEM: path.join(runDir, 'absent-config'),
    GIT_CONFIG_COUNT: undefined,
    CODEX_RUNS_ROOT: path.join(runDir, 'runs'),
  };
  const saved = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  const setEnvironment = (values) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  setEnvironment(environment);
  t.after(() => setEnvironment(saved));
  const git = (...args) => {
    const result = spawnSync('git', ['-C', repoRoot, '-c', 'core.autocrlf=false', ...args], {
      encoding: 'utf8', windowsHide: true, timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const write = (name, content) => {
    const full = path.join(repoRoot, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  git('init', '-q');
  write('dirty.txt', 'start\n');
  write('clean.txt', '// TODO: inherited\nkeep\n');
  write('move.txt', '// TODO: move\na\nb\nc\nd\ne\n');
  write('crlf.txt', 'start\r\n// TODO: inherited\r\n');
  write('empty.txt', '');
  git('add', '--', 'dirty.txt', 'clean.txt', 'move.txt', 'crlf.txt', 'empty.txt');
  git('-c', 'user.name=Flag Scan Test', '-c', 'user.email=flags@example.test',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'flag scan fixture');
  const capture = (limits) => {
    fs.writeFileSync(path.join(runDir, 'state-before.txt'), worktreeSnapshot(repoRoot));
    return captureFlagBaseline({ runDir, repoRoot, isGitRepo: true, ...(limits ? { limits } : {}) });
  };
  const scan = () => {
    fs.writeFileSync(path.join(runDir, 'state-after.txt'), worktreeSnapshot(repoRoot));
    return scanRunFlags({ runDir, repoRoot });
  };
  return { repoRoot, runDir, write, capture, scan };
}

function mockSpawn(t, callback) {
  const original = childProcess.spawnSync;
  const mocked = t.mock.method(childProcess, 'spawnSync', (command, args, options) =>
    callback(command, args, options, original));
  syncBuiltinESMExports();
  t.after(() => {
    mocked.mock.restore();
    syncBuiltinESMExports();
  });
}

test('marker grammar recognizes comments, lists and stubs without matching data or prose', () => {
  const qualifying = [
    'TODO: implement', '\t FIXME', 'TODO', 'FIXME!', '// TODO: later', 'code(); // TODO: later',
    '/* TODO */', '/*** FIXME: x */', '# FIXME: y', '<!-- TODO -->', '-- TODO', ' * TODO',
    '1. TODO', '2) FIXME', '- TODO', '+ TODO', '* TODO', '- [ ] TODO: x', '- [x] FIXME',
    '- [X] TODO', "test.skip('x', () => {});", "test.only('x');", "it.skip('x');",
    "it.only('x');", "describe.skip('x');", "describe.only('x');", 'throw new NotImplemented();',
  ];
  const ordinary = [
    "['', 'TODO', '<phase>']", "for (const value of ['', 'TODO', '<phase>']) {", 'todo', 'TODOS',
    'see the TODO list', 'TODO_LIST = 1', '@todo', 'TODO1', '// FIXME_more', 'prefix TODO',
    '- [x]TODO', '1.TODO', 'x * TODO', '/* see TODO */', 'fixme', '// TODOS',
  ];
  for (const line of qualifying) assert.equal(isFlagLine(line), true, line);
  for (const line of ordinary) assert.equal(isFlagLine(line), false, line);
});

test('unchanged earlier dirty flags and an earlier untracked folder contribute no hits', (t) => {
  const { write, capture, scan } = fixture(t);
  write('dirty.txt', 'start\n// TODO: earlier\n');
  write('earlier/a.md', 'TODO: earlier\n');
  write('earlier/nested/b.md', '- [ ] TODO: earlier\n');
  capture();
  assert.deepEqual(scan(), { text: '', coverage: { complete: true, gaps: [] } });
});

test('a marker appended to a dirty start file has the current line number', (t) => {
  const { write, capture, scan, runDir } = fixture(t);
  write('dirty.txt', 'start\nearlier dirty\n');
  const manifest = capture();
  write('dirty.txt', 'start\nearlier dirty\n// TODO: later\n');
  assert.deepEqual(scan(), {
    text: 'dirty.txt:3: // TODO: later\n', coverage: { complete: true, gaps: [] },
  });
  assert.equal(fs.existsSync(path.join(runDir, FLAG_BASELINE_DIR)), false);
  assert.deepEqual(readFlagBaseline(runDir), manifest);
});

test('added quoted TODO data is ordinary while an added skipped test is a flag', (t) => {
  const { write, capture, scan } = fixture(t);
  capture();
  write('dirty.txt', "start\nfor (const value of ['', 'TODO', '<phase>']) {\n}\ntest.skip('x', () => {});\n");
  assert.equal(scan().text, "dirty.txt:4: test.skip('x', () => {});\n");
});

test('clean-at-start HEAD excludes inherited TODO and its temporary copy is deleted promptly', (t) => {
  const { write, capture, scan, runDir } = fixture(t);
  capture();
  write('clean.txt', '// TODO: inherited\nkeep\n# FIXME: y\n');
  const unlink = fs.unlinkSync;
  const removed = [];
  t.mock.method(fs, 'unlinkSync', (file) => {
    removed.push(file);
    return unlink(file);
  });
  assert.deepEqual(scan(), { text: 'clean.txt:3: # FIXME: y\n', coverage: { complete: true, gaps: [] } });
  assert.equal(removed.length, 1);
  assert.equal(path.dirname(removed[0]), path.join(runDir, FLAG_BASELINE_DIR));
  assert.equal(fs.existsSync(path.join(runDir, FLAG_BASELINE_DIR)), false);
});

test('an unreadable start commit is a gap for clean-at-start files, never a whole-file accusation', (t) => {
  const { write, capture, scan, runDir } = fixture(t);
  capture();
  const manifestFile = path.join(runDir, FLAG_BASELINE_MANIFEST);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, head: '0'.repeat(40) }));
  write('clean.txt', '// TODO: inherited\nkeep\nmore\n');
  write('fresh.md', 'TODO: new\n');
  assert.deepEqual(scan(), {
    text: '',
    coverage: { complete: false, gaps: ['clean.txt: start commit unreadable', 'fresh.md: start commit unreadable'] },
  });
});

test('a newly added Cyrillic Markdown path is printed exactly', (t) => {
  const { write, capture, scan } = fixture(t);
  capture();
  write('проверка.md', 'TODO: implement\n');
  assert.equal(scan().text, 'проверка.md:1: TODO: implement\n');
});

test('a removed and reinserted TODO is an accepted moved-line residual', (t) => {
  const { write, capture, scan } = fixture(t);
  capture();
  write('move.txt', 'a\nb\nc\nd\ne\n// TODO: move\n');
  assert.equal(scan().text, 'move.txt:6: // TODO: move\n');
});

test('rewriting a dirty CRLF start file with LF alone adds no flags', (t) => {
  const { write, capture, scan } = fixture(t);
  write('crlf.txt', 'dirty\r\n// TODO: inherited\r\n');
  capture();
  write('crlf.txt', 'dirty\n// TODO: inherited\n');
  assert.deepEqual(scan(), { text: '', coverage: { complete: true, gaps: [] } });
});

test('plus-prefixed added content is not mistaken for a file header', (t) => {
  const { write, capture, scan } = fixture(t);
  capture();
  write('dirty.txt', 'start\n++i; // TODO: bump\n');
  assert.equal(scan().text, 'dirty.txt:2: ++i; // TODO: bump\n');
});

test('unknown truncated start bytes leave an explicit path gap and no hit', (t) => {
  const { write, capture, scan } = fixture(t);
  write('dirty.txt', 'earlier content too large\n');
  const manifest = capture({ perFileBytes: 20, perRunBytes: 100 });
  assert.equal(manifest.files[0].state, 'truncated');
  write('dirty.txt', '// TODO: new\n');
  assert.deepEqual(scan(), {
    text: '', coverage: { complete: false, gaps: ['dirty.txt: start content truncated'] },
  });
});

test('missing baseline and incomplete empty baseline refuse judgement with their specified gaps', (t) => {
  const { repoRoot, runDir } = fixture(t);
  assert.deepEqual(scanRunFlags({ runDir, repoRoot }), {
    text: '', coverage: { complete: false, gaps: ['no flag baseline'] },
  });
  captureFlagBaseline({ runDir, repoRoot, isGitRepo: false });
  assert.deepEqual(scanRunFlags({ runDir, repoRoot }), {
    text: '', coverage: { complete: false, gaps: ['flag baseline incomplete: not a git repository'] },
  });
});

test('incomparable snapshots restrict candidates to the manifest', (t) => {
  const { repoRoot, runDir, write, capture } = fixture(t);
  write('dirty.txt', 'dirty\n');
  capture();
  write('dirty.txt', 'dirty\n// TODO: new\n');
  write('new.md', 'TODO: unseen\n');
  assert.deepEqual(scanRunFlags({ runDir, repoRoot }), {
    text: 'dirty.txt:2: // TODO: new\n',
    coverage: { complete: false, gaps: ['snapshots not comparable'] },
  });
});

test('end limits are explicit while missing, non-regular and binary end files are skipped', (t) => {
  const { repoRoot, write, capture, scan } = fixture(t);
  write('dirty.txt', 'dirty\n');
  write('new.md', 'start\n');
  write('directory.md', 'start\n');
  capture({ perFileBytes: 40, perRunBytes: 100 });
  write('dirty.txt', `// TODO: ${'x'.repeat(50)}\n`);
  write('clean.txt', Buffer.from('// TODO: binary\0\n'));
  fs.unlinkSync(path.join(repoRoot, 'new.md'));
  fs.unlinkSync(path.join(repoRoot, 'directory.md'));
  fs.mkdirSync(path.join(repoRoot, 'directory.md'));
  assert.deepEqual(scan(), {
    text: '', coverage: { complete: false, gaps: ['dirty.txt: end content over the limit'] },
  });
});

test('deleted and absent starts and empty HEAD files treat all current lines as added', (t) => {
  const { repoRoot, runDir, write, capture, scan } = fixture(t);
  fs.unlinkSync(path.join(repoRoot, 'dirty.txt'));
  capture();
  const manifest = readFlagBaseline(runDir);
  manifest.files.push({ path: 'new.md', tracked: false, state: 'absent' });
  fs.writeFileSync(path.join(runDir, FLAG_BASELINE_MANIFEST), JSON.stringify(manifest));
  write('dirty.txt', 'TODO: restored\n');
  write('empty.txt', '# FIXME: empty\n');
  write('new.md', 'TODO: new\n');
  assert.deepEqual(scan(), {
    text: 'dirty.txt:1: TODO: restored\nempty.txt:1: # FIXME: empty\nnew.md:1: TODO: new\n',
    coverage: { complete: true, gaps: [] },
  });
});

test('20-hit cap retains sorted path/line order and does not hide later coverage gaps', (t) => {
  const { write, capture, scan } = fixture(t);
  capture({ perFileBytes: 1000, perRunBytes: 1000 });
  write('b.md', 'TODO: b\n');
  write('a.md', Array.from({ length: 22 }, (_, index) => `TODO: ${index}`).join('\n') + '\n');
  write('z.md', 'x'.repeat(1001));
  const result = scan();
  assert.equal(result.text, Array.from({ length: 20 }, (_, index) =>
    `a.md:${index + 1}: TODO: ${index}\n`).join(''));
  assert.deepEqual(result.coverage, { complete: false, gaps: ['z.md: end content over the limit'] });
});

test('only hunk additions count, including multiple hunks and CRLF/nonfatal UTF-8', (t) => {
  const { write, capture, scan } = fixture(t);
  capture();
  write('dirty.txt', 'changed\n');
  mockSpawn(t, (command, args, options, original) => {
    if (!args.includes('--no-index')) return original(command, args, options);
    return { status: 1, stdout: Buffer.concat([
      Buffer.from('diff --git a b\n--- TODO: header\n+++ TODO: header\n+TODO: outside\n'),
      Buffer.from('@@ -1 +2,2 @@\n-old\n+++i; // TODO: bump\n+'), Buffer.from([0xff]),
      Buffer.from(' // FIXME: bytes\r\n@@ -3,0 +8 @@\n+TODO: later\n'),
      Buffer.from('diff --git c d\n+TODO: outside again\n'),
    ]) };
  });
  assert.equal(scan().text,
    'dirty.txt:2: ++i; // TODO: bump\ndirty.txt:3: � // FIXME: bytes\ndirty.txt:8: TODO: later\n');
});

for (const failure of [
  { status: 2 }, { status: null, error: { code: 'ETIMEDOUT' } },
  { status: 1, error: { code: 'ENOBUFS' } },
]) {
  test(`failed diff ${failure.error?.code || failure.status} is a gap and cleans copies`, (t) => {
    const { write, capture, scan, runDir } = fixture(t);
    capture();
    write('dirty.txt', '// TODO: new\n');
    mockSpawn(t, (command, args, options, original) => {
      if (!args.includes('--no-index')) return original(command, args, options);
      assert.equal(options.windowsHide, true);
      assert.equal(options.timeout, 30_000);
      assert.equal(options.maxBuffer, 8 * 1024 * 1024);
      assert.equal(options.encoding, undefined);
      return { stdout: Buffer.from('+TODO: not evidence\n'), ...failure };
    });
    assert.deepEqual(scan(), { text: '', coverage: { complete: false, gaps: ['dirty.txt: diff failed'] } });
    assert.equal(fs.existsSync(path.join(runDir, FLAG_BASELINE_DIR)), false);
    assert.equal(fs.existsSync(path.join(runDir, FLAG_BASELINE_MANIFEST)), true);
  });
}
