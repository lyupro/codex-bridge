/** Plan_77 D4/D7: preflight and verified history precede the switch; the legacy store stays untouched. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { runsRootResolution } from '../../src/home/lib/runner/runs-root.mjs';
import { readRunsMoveRecord } from '../../src/home/lib/runner/retired-roots.mjs';
import { runsMove } from '../../cli/runs-move.mjs';
import { withTempTree } from '../temp-tree.mjs';
import { fixture, snapshot } from './runs-move-fixtures.mjs';

for (const source of ['CODEX_RUNS_ROOT', 'default']) {
  test(`${source} resolution refuses before liveness or any write`, async () => {
    await withTempTree('runs-move-refusal-', (root) => {
      const resolution = { ...fixture(root), source };
      const before = snapshot(root);
      const expected = source === 'CODEX_RUNS_ROOT'
        ? `CODEX_RUNS_ROOT is set to ${resolution.root}; unset it to move the default run store.`
        : `No run store to move: ${resolution.legacyRoot} does not exist.`;
      for (const dryRun of [false, true]) {
        const result = runsMove({ resolution, dryRun, liveRuns: () => assert.fail('resolution refuses first') });
        assert.deepEqual(result, { exitCode: 1, output: expected, oldStore: null, homeRoot: resolution.homeRoot });
        assert.deepEqual(snapshot(root), before);
      }
    });
  });
}

test('any live run under the legacy root refuses before destination checks; dry run names every refusal', async () => {
  await withTempTree('runs-move-live-', (root) => {
    const resolution = fixture(root);
    fs.mkdirSync(resolution.homeRoot, { recursive: true });
    fs.writeFileSync(path.join(resolution.homeRoot, 'existing'), 'keep');
    const dirs = [path.join(resolution.legacyRoot, 'project', 'one'), path.join(resolution.legacyRoot, 'other', 'two')];
    const live = `Runs are still live in ${resolution.legacyRoot}:\n${dirs.join('\n')}. Wait for them or stop them with codex-bridge stop, then repeat.`;
    const before = snapshot(root);
    for (const dryRun of [false, true]) {
      let calls = 0;
      const result = runsMove({ resolution, dryRun, liveRuns: (scannedRoot) => {
        calls += 1;
        assert.equal(scannedRoot, resolution.legacyRoot);
        return dirs.map((dir) => ({ dir, status: { state: 'running' } }));
      } });
      assert.deepEqual(result, { exitCode: 1, oldStore: null, homeRoot: resolution.homeRoot,
        output: dryRun ? `${live}\nRun store destination is not an empty directory: ${resolution.homeRoot}.` : live });
      assert.equal(calls, 1);
      assert.deepEqual(snapshot(root), before);
    }
  });
});

test('dry run with live runs still previews the move and creates nothing (like purge --dry-run)', async () => {
  await withTempTree('runs-move-live-preview-', (root) => {
    const resolution = fixture(root);
    const dir = path.join(resolution.legacyRoot, 'project', 'one');
    const before = snapshot(root);
    const result = runsMove({ resolution, dryRun: true, liveRuns: () => [{ dir, status: { state: 'running' } }] });
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /^Runs are still live in /);
    assert.match(result.output, /\nWould copy \d+ files .* Dry run: nothing changed\.$/);
    assert.equal(result.oldStore, null);
    assert.deepEqual(snapshot(root), before);
    assert.equal(fs.existsSync(resolution.homeRoot), false);
  });
});

test('non-empty home root and a file home root are refused without changing either tree', async () => {
  await withTempTree('runs-move-busy-home-', (root) => {
    const resolution = fixture(root);
    fs.mkdirSync(resolution.homeRoot, { recursive: true });
    fs.writeFileSync(path.join(resolution.homeRoot, 'keep'), 'operator data');
    const file = path.join(root, 'file-destination');
    fs.writeFileSync(file, 'keep');
    const before = snapshot(root);
    for (const homeRoot of [resolution.homeRoot, file]) {
      for (const dryRun of [false, true]) {
        assert.deepEqual(runsMove({ resolution: { ...resolution, homeRoot }, dryRun, liveRuns: () => [] }),
          { exitCode: 1, oldStore: null, homeRoot, output: `Run store destination is not an empty directory: ${homeRoot}.` });
      }
    }
    assert.deepEqual(snapshot(root), before);
  });
});

test('dry run counts files, empty folders and MiB without creating the home', async () => {
  await withTempTree('runs-move-dry-', (root) => {
    const resolution = fixture(root);
    fs.writeFileSync(path.join(resolution.legacyRoot, 'large.log'), Buffer.alloc(1024 * 1024, 42));
    const before = snapshot(root);
    const result = runsMove({ resolution, dryRun: true, liveRuns: () => [] });
    assert.deepEqual(result, { exitCode: 0, oldStore: null, homeRoot: resolution.homeRoot,
      output: `Would copy 3 files (1.00 MB) in 2 folders from ${resolution.legacyRoot} to ${resolution.homeRoot}; history: not in git. Dry run: nothing changed.` });
    assert.deepEqual(snapshot(root), before);
    assert.equal(fs.existsSync(path.dirname(resolution.homeRoot)), false);
  });
});

test('real move preserves every legacy byte and writes the record that switches the resolver', async () => {
  await withTempTree('runs-move-real-', (root) => {
    const resolution = fixture(root);
    const before = snapshot(resolution.legacyRoot);
    const result = runsMove({ resolution, liveRuns: () => [] });
    assert.deepEqual(result, { exitCode: 0, oldStore: resolution.legacyRoot, homeRoot: resolution.homeRoot,
      output: `Moved 2 files (0.00 MB) from ${resolution.legacyRoot} to ${resolution.homeRoot}; history: not in git. New runs write to ${resolution.homeRoot}. The old folder is untouched.` });
    assert.deepEqual(snapshot(resolution.legacyRoot), before);
    assert.deepEqual(snapshot(resolution.homeRoot), before);
    assert.deepEqual(fs.readdirSync(path.dirname(resolution.homeRoot)).sort(), ['runs', 'state']);
    // D7: the record must switch the resolver even while the old folder still exists.
    const record = readRunsMoveRecord(resolution.stateDir);
    assert.equal(record.retired.length, 1);
    assert.equal(record.retired[0].root, resolution.legacyRoot);
    const switched = runsRootResolution({ homedir: root, env: { CODEX_BRIDGE_HOME: path.join(root, 'home') } });
    assert.equal(switched.source, 'moved');
    assert.equal(switched.root, resolution.homeRoot);
  });
});

test('copy error reports nothing switched and removes only the partial destination', async (t) => {
  await withTempTree('runs-move-error-', (root) => {
    const resolution = fixture(root);
    const before = snapshot(resolution.legacyRoot);
    const copy = fs.copyFileSync;
    t.mock.method(fs, 'copyFileSync', (src, dst, flags) => {
      if (path.basename(src) === 'events.jsonl') throw new Error(`Cannot copy ${src}`);
      return copy(src, dst, flags);
    });
    const result = runsMove({ resolution, liveRuns: () => [] });
    assert.deepEqual(result, { exitCode: 1, oldStore: null, homeRoot: resolution.homeRoot,
      output: `Cannot copy ${path.join(resolution.legacyRoot, 'project', 'events.jsonl')}\nNothing was switched; the old folder is untouched.` });
    assert.equal(fs.existsSync(resolution.homeRoot), false);
    assert.deepEqual(snapshot(resolution.legacyRoot), before);
    assert.deepEqual(fs.readdirSync(path.dirname(resolution.homeRoot)), []);
  });
});

test('missing legacy source fails loudly with no switch or destination', async () => {
  await withTempTree('runs-move-missing-', (root) => {
    const resolution = { source: 'legacy', root: path.join(root, 'missing'),
      legacyRoot: path.join(root, 'missing'), homeRoot: path.join(root, 'home', 'runs') };
    const result = runsMove({ resolution, liveRuns: () => [] });
    assert.equal(result.exitCode, 1);
    assert.equal(result.oldStore, null);
    assert.equal(result.homeRoot, resolution.homeRoot);
    assert.ok(result.output.includes(resolution.legacyRoot));
    assert.match(result.output, /Nothing was switched; the old folder is untouched\./);
    assert.deepEqual(fs.readdirSync(root), []);
  });
});

function fixtureGit(root) {
  // D4: fixture repositories have their own identity and never read the operator's Git config.
  return (cwd, args) => spawnSync('git', ['-C', cwd,
    '-c', 'user.name=Run records test', '-c', 'user.email=runs@example.test', ...args], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, HOME: root, USERPROFILE: root, GIT_CONFIG_GLOBAL: path.join(root, 'missing-gitconfig'),
      GIT_CONFIG_SYSTEM: path.join(root, 'missing-gitconfig') },
  });
}

function commitFixture(resolution, git) {
  const top = path.dirname(resolution.legacyRoot);
  for (const args of [['init', '--quiet'], ['add', '-A'], ['commit', '--quiet', '-m', 'run records']]) {
    const result = git(top, args);
    assert.equal(result.status, 0, result.stderr);
  }
  return top;
}

test('history import sees the verified copy before the D7 record and success reports imported commits', async () => {
  await withTempTree('runs-move-history-order-', (root) => {
    const resolution = fixture(root);
    const before = snapshot(resolution.legacyRoot);
    const git = fixtureGit(root);
    commitFixture(resolution, git);
    let sawStaging = false;
    const result = runsMove({ resolution, liveRuns: () => [], git: (cwd, args) => {
      if (cwd.startsWith(`${resolution.homeRoot}.moving-`)) {
        sawStaging = true;
        assert.deepEqual(snapshot(resolution.legacyRoot), before);
        assert.equal(readRunsMoveRecord(resolution.stateDir), null);
        assert.equal(fs.readFileSync(path.join(cwd, '.project.json'), 'utf8'), '{}');
      }
      return git(cwd, args);
    } });
    assert.deepEqual(result, { exitCode: 0, oldStore: resolution.legacyRoot, homeRoot: resolution.homeRoot,
      output: `Moved 2 files (0.00 MB) from ${resolution.legacyRoot} to ${resolution.homeRoot}; history: imported 1 commits. New runs write to ${resolution.homeRoot}. The old folder is untouched.` });
    assert.ok(sawStaging, 'history import must run in staging');
    assert.equal(git(resolution.homeRoot, ['status', '--porcelain']).stdout.trim(), '');
    assert.equal(readRunsMoveRecord(resolution.stateDir).retired[0].root, resolution.legacyRoot);
  });
});

test('dry run reports history eligibility using only read commands, without copying or switching', async () => {
  await withTempTree('runs-move-dry-history-', (root) => {
    const resolution = fixture(root);
    const git = fixtureGit(root);
    commitFixture(resolution, git);
    const before = snapshot(root);
    const calls = [];
    const result = runsMove({ resolution, dryRun: true, liveRuns: () => [],
      importHistory: () => assert.fail('dry run must not import history'), git: (cwd, args) => {
        calls.push(args[0]);
        return git(cwd, args);
      } });
    assert.equal(result.exitCode, 0, result.output);
    assert.equal(result.oldStore, null);
    assert.equal(result.homeRoot, resolution.homeRoot);
    assert.match(result.output, /history: would import 1 commits\. Dry run: nothing changed\./);
    assert.deepEqual(calls, ['rev-parse', 'rev-list']);
    assert.deepEqual(snapshot(root), before);
    assert.equal(fs.existsSync(resolution.homeRoot), false);
    assert.equal(readRunsMoveRecord(resolution.stateDir), null);
  });
});

for (const existing of [false, true]) {
  test(`history failure removes the ${existing ? 'initially empty' : 'new'} copy and writes no move record`, async () => {
    await withTempTree('runs-move-history-error-', (root) => {
      const resolution = fixture(root);
      if (existing) fs.mkdirSync(resolution.homeRoot, { recursive: true });
      const before = snapshot(resolution.legacyRoot);
      const result = runsMove({ resolution, liveRuns: () => [], importHistory: ({ from, to }) => {
        assert.equal(from, resolution.legacyRoot);
        assert.ok(to.startsWith(`${resolution.homeRoot}.moving-`));
        assert.deepEqual(snapshot(to), before);
        assert.equal(readRunsMoveRecord(resolution.stateDir), null);
        throw new Error('Git subtree failed (exit 7): injected failure');
      } });
      assert.deepEqual(result, { exitCode: 1, oldStore: null, homeRoot: resolution.homeRoot,
        output: 'Git subtree failed (exit 7): injected failure\nNothing was switched; the old folder is untouched.' });
      assert.equal(fs.existsSync(resolution.homeRoot), existing);
      assert.deepEqual(fs.readdirSync(path.dirname(resolution.homeRoot)), existing ? ['runs'] : []);
      assert.deepEqual(snapshot(resolution.legacyRoot), before);
      assert.equal(readRunsMoveRecord(resolution.stateDir), null);
    });
  });
}

test('an explicitly injected state directory receives the final move record', async () => {
  await withTempTree('runs-move-state-dir-', (root) => {
    const resolution = fixture(root);
    const stateDir = path.join(root, 'injected', 'state');
    const result = runsMove({ resolution, stateDir, liveRuns: () => [] });
    assert.equal(result.exitCode, 0, result.output);
    assert.equal(result.oldStore, resolution.legacyRoot);
    assert.equal(result.homeRoot, resolution.homeRoot);
    assert.equal(readRunsMoveRecord(stateDir).retired[0].root, resolution.legacyRoot);
    assert.equal(readRunsMoveRecord(resolution.stateDir), null);
  });
});

// D3/B5c: a repeated command offers the leftover old folder without copying or switching again.
test('moved resolution with an old directory succeeds and exposes it only outside dry runs', async () => {
  await withTempTree('runs-move-already-', (root) => {
    const resolution = { ...fixture(root), source: 'moved' };
    const before = snapshot(root);
    for (const dryRun of [false, true]) {
      const result = runsMove({ resolution, dryRun,
        liveRuns: () => assert.fail('already moved must not copy or inspect live runs'),
        importHistory: () => assert.fail('already moved must not import history') });
      assert.deepEqual(result, { exitCode: 0, oldStore: dryRun ? null : resolution.legacyRoot,
        homeRoot: resolution.homeRoot,
        output: `Run records already live in ${resolution.homeRoot}; the old folder ${resolution.legacyRoot} still exists.` });
      assert.deepEqual(snapshot(root), before);
    }
  });
});

for (const kind of ['absent', 'file']) {
  test(`moved resolution with an ${kind} legacy root still refuses without offering removal`, async () => {
    await withTempTree('runs-move-no-old-directory-', (root) => {
      const resolution = { ...fixture(root), source: 'moved' };
      fs.renameSync(resolution.legacyRoot, path.join(root, 'preserved'));
      if (kind === 'file') fs.writeFileSync(resolution.legacyRoot, 'keep');
      const before = snapshot(root);
      for (const dryRun of [false, true]) {
        const result = runsMove({ resolution, dryRun,
          liveRuns: () => assert.fail('already moved must not inspect live runs') });
        assert.deepEqual(result, { exitCode: 1, oldStore: null, homeRoot: resolution.homeRoot,
          output: `Run records already live in ${resolution.homeRoot}.` });
        assert.deepEqual(snapshot(root), before);
      }
    });
  });
}
