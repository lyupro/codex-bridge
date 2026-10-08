/** Plan_77 D4: import from a clone; preserve the source history, index and working tree byte-for-byte. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { copyRunStore } from '../../cli/runs-move-copy.mjs';
import { importRunHistory, inspectRunHistory, runGit } from '../../cli/runs-move-history.mjs';
import { withTempTree } from '../temp-tree.mjs';

// Plan_77 F1: the caller creates the staging folder that copyRunStore fills and may roll back.
function copyIntoStaging({ from, to }) {
  fs.mkdirSync(to);
  return copyRunStore({ from, to });
}

function isolatedGit(root, work) {
  const keys = ['HOME', 'USERPROFILE', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM'];
  const saved = keys.map((key) => [key, process.env[key]]);
  for (const key of keys) process.env[key] = ['HOME', 'USERPROFILE'].includes(key) ? root : path.join(root, 'missing-gitconfig');
  // D4 fixtures must not inherit identity, hooks or excludes from the operator's configuration.
  const git = (cwd, args) => runGit(cwd, ['-c', 'user.name=Run records test', '-c', 'user.email=runs@example.test', ...args]);
  try {
    return work(git);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function checked(git, cwd, args) {
  const result = git(cwd, args);
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function fixture(root, git) {
  const top = path.join(root, 'repository');
  const from = path.join(top, 'codex-runs');
  const to = path.join(root, 'copy');
  fs.mkdirSync(from, { recursive: true });
  checked(git, top, ['init', '--quiet']);
  const commit = (message) => {
    checked(git, top, ['add', '-A']);
    checked(git, top, ['commit', '--quiet', '-m', message]);
  };
  fs.writeFileSync(path.join(from, 'keep.txt'), 'first\n');
  fs.writeFileSync(path.join(from, 'deleted.txt'), 'historical\n');
  commit('first run records');
  fs.writeFileSync(path.join(top, 'unrelated.txt'), 'unrelated\n');
  commit('unrelated change');
  fs.writeFileSync(path.join(from, 'keep.txt'), 'second\n');
  commit('second run records');
  fs.unlinkSync(path.join(from, 'deleted.txt'));
  commit('delete old record');
  return { top, from, to };
}

function sourceState(git, top) {
  return {
    head: checked(git, top, ['rev-parse', 'HEAD']),
    refs: checked(git, top, ['show-ref']),
    // Read status before the index snapshot: Git itself may refresh stat metadata during status.
    status: checked(git, top, ['status', '--porcelain']),
    index: fs.readFileSync(path.join(top, '.git', 'index')),
  };
}

function assertSourceUnchanged(git, top, before) {
  assert.deepEqual(fs.readFileSync(path.join(top, '.git', 'index')), before.index);
  assert.equal(checked(git, top, ['rev-parse', 'HEAD']), before.head);
  assert.equal(checked(git, top, ['show-ref']), before.refs);
  assert.equal(checked(git, top, ['status', '--porcelain']), before.status);
}

test('imports three root-rewritten commits and the current records without touching the source repository', async () => {
  await withTempTree('runs-history-import-', (root) => isolatedGit(root, (git) => {
    const { top, from, to } = fixture(root, git);
    // D4: dirty, staged and untracked records all travel above the imported historical tip.
    fs.writeFileSync(path.join(from, 'keep.txt'), 'staged\n');
    checked(git, top, ['add', 'codex-runs/keep.txt']);
    fs.writeFileSync(path.join(from, 'keep.txt'), 'current\n');
    fs.writeFileSync(path.join(from, 'new.txt'), 'untracked\n');
    const before = sourceState(git, top);
    copyIntoStaging({ from, to });
    assert.deepEqual(importRunHistory({ from, to, git, tmpdir: root }), { imported: true, commits: 4 });
    assert.deepEqual(checked(git, to, ['log', '--reverse', '--format=%s']).split('\n'), [
      'first run records', 'second run records', 'delete old record',
      'Import run records moved by codex-bridge (Plan_77)',
    ]);
    assert.deepEqual(checked(git, to, ['ls-tree', '-r', '--name-only', 'HEAD~3']).split('\n'), ['deleted.txt', 'keep.txt']);
    assert.equal(fs.existsSync(path.join(to, 'deleted.txt')), false);
    assert.equal(fs.readFileSync(path.join(to, 'keep.txt'), 'utf8'), 'current\n');
    assert.equal(fs.readFileSync(path.join(to, 'new.txt'), 'utf8'), 'untracked\n');
    assert.equal(checked(git, to, ['status', '--porcelain']), '');
    assertSourceUnchanged(git, top, before);
    assert.ok(!fs.readdirSync(root).some((name) => name.startsWith('codex-bridge-runs-history-')));
  }));
});

test('matching copied records keep only the three history commits, with no empty import commit', async () => {
  await withTempTree('runs-history-matching-', (root) => isolatedGit(root, (git) => {
    const { from, to } = fixture(root, git);
    copyIntoStaging({ from, to });
    assert.deepEqual(importRunHistory({ from, to, git, tmpdir: root }), { imported: true, commits: 3 });
    assert.equal(checked(git, to, ['status', '--porcelain']), '');
    assert.equal(checked(git, to, ['log', '-1', '--format=%s']), 'delete old record');
  }));
});

test('a store outside git skips history without creating metadata or a clone', async () => {
  await withTempTree('runs-history-no-git-', (root) => isolatedGit(root, () => {
    const from = path.join(root, 'source');
    const to = path.join(root, 'copy');
    fs.mkdirSync(from);
    fs.writeFileSync(path.join(from, 'record'), 'record');
    copyIntoStaging({ from, to });
    const before = fs.readdirSync(root);
    assert.deepEqual(importRunHistory({ from, to, tmpdir: root }), { imported: false, reason: 'not in git' });
    assert.equal(fs.existsSync(path.join(to, '.git')), false);
    assert.deepEqual(fs.readdirSync(root), before);
  }));
});

test('a repository-top store and a store with no commits touching its prefix skip history', async () => {
  await withTempTree('runs-history-skips-', (root) => isolatedGit(root, (git) => {
    const { top, to } = fixture(root, git);
    const unused = path.join(top, 'never-committed');
    fs.mkdirSync(unused);
    assert.deepEqual(importRunHistory({ from: top, to, git, tmpdir: root }),
      { imported: false, reason: 'store is a repository of its own' });
    assert.deepEqual(importRunHistory({ from: unused, to, git, tmpdir: root }),
      { imported: false, reason: 'no history' });
    assert.equal(fs.existsSync(to), false);
  }));
});

test('history eligibility uses only rev-parse and rev-list without creating anything', async () => {
  await withTempTree('runs-history-probe-', (root) => isolatedGit(root, (git) => {
    const { top, from } = fixture(root, git);
    const before = sourceState(git, top);
    const calls = [];
    const result = inspectRunHistory({ from, git: (cwd, args) => {
      calls.push([cwd, args]);
      return git(cwd, args);
    } });
    assert.equal(result.commits, 3);
    assert.equal(result.prefix, 'codex-runs');
    assert.deepEqual(calls, [[from, ['rev-parse', '--show-toplevel']],
      [result.top, ['rev-list', '--count', 'HEAD', '--', 'codex-runs']]]);
    assertSourceUnchanged(git, top, before);
  }));
});

// D4: every failing Git step must remove the clone; only newly created destination metadata is ours.
for (const step of ['clone', 'checkout', 'subtree', 'init', 'fetch', 'reset', 'add', 'diff', 'commit', 'rev-list']) {
  test(`a ${step} failure names its exit and first stderr line and rolls back import metadata`, async () => {
    await withTempTree(`runs-history-${step}-failure-`, (root) => isolatedGit(root, (git) => {
      const { top, from, to } = fixture(root, git);
      fs.writeFileSync(path.join(from, 'new.txt'), 'current');
      copyIntoStaging({ from, to });
      const before = sourceState(git, top);
      const failing = (cwd, args) => {
        // The final rev-list is a separate failure point from the read-only source probe.
        if (args[0] === step && (step !== 'rev-list' || cwd === to)) {
          if (step === 'init') checked(git, cwd, args); // Partial init must also be undone.
          return { status: 7, stdout: '', stderr: 'injected first line\nignored second line\n' };
        }
        return git(cwd, args);
      };
      assert.throws(() => importRunHistory({ from, to, git: failing, tmpdir: root }),
        { message: `Git ${step} failed (exit 7): injected first line` });
      assert.equal(fs.existsSync(path.join(to, '.git')), false);
      assert.equal(fs.readFileSync(path.join(to, 'new.txt'), 'utf8'), 'current');
      assertSourceUnchanged(git, top, before);
      assert.ok(!fs.readdirSync(root).some((name) => name.startsWith('codex-bridge-runs-history-')));
    }));
  });
}

test('an existing destination repository is not removed when import fails', async () => {
  await withTempTree('runs-history-existing-git-', (root) => isolatedGit(root, (git) => {
    const { from, to } = fixture(root, git);
    copyIntoStaging({ from, to });
    checked(git, to, ['init', '--quiet']);
    assert.throws(() => importRunHistory({ from, to, tmpdir: root, git: (cwd, args) =>
      args[0] === 'fetch' ? { status: 9, stdout: '', stderr: 'fetch failed' } : git(cwd, args) }), /Git fetch failed \(exit 9\)/);
    assert.equal(fs.existsSync(path.join(to, '.git')), true);
    assert.ok(!fs.readdirSync(root).some((name) => name.startsWith('codex-bridge-runs-history-')));
  }));
});
