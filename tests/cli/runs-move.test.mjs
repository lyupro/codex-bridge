/** Plan_77 D3/D7: preflight comes first and B5a never switches or removes the legacy store. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runsMove } from '../../cli/runs-move.mjs';
import { withTempTree } from '../temp-tree.mjs';

function snapshot(root) {
  const result = {};
  function walk(relative) {
    for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
      const child = path.join(relative, name);
      const file = path.join(root, child);
      if (fs.lstatSync(file).isDirectory()) {
        result[child] = 'directory';
        walk(child);
      } else result[child] = fs.readFileSync(file).toString('hex');
    }
  }
  walk('');
  return result;
}

function fixture(root) {
  const legacyRoot = path.join(root, 'legacy');
  const homeRoot = path.join(root, 'home', 'runs');
  fs.mkdirSync(path.join(legacyRoot, 'project', 'empty'), { recursive: true });
  fs.writeFileSync(path.join(legacyRoot, 'project', 'events.jsonl'), Buffer.from([0, 10, 255]));
  fs.writeFileSync(path.join(legacyRoot, '.project.json'), '{}');
  return { root: legacyRoot, source: 'legacy', legacyRoot, homeRoot };
}

for (const source of ['CODEX_RUNS_ROOT', 'moved', 'default']) {
  test(`${source} resolution refuses before liveness or any write`, async () => {
    await withTempTree('runs-move-refusal-', (root) => {
      const resolution = { ...fixture(root), source };
      const before = snapshot(root);
      const expected = source === 'CODEX_RUNS_ROOT'
        ? `CODEX_RUNS_ROOT is set to ${resolution.root}; unset it to move the default run store.`
        : source === 'moved' ? `Run records already live in ${resolution.homeRoot}.`
          : `No run store to move: ${resolution.legacyRoot} does not exist.`;
      for (const dryRun of [false, true]) {
        const result = runsMove({ resolution, dryRun, liveRuns: () => assert.fail('resolution refuses first') });
        assert.deepEqual(result, { exitCode: 1, output: expected });
        assert.deepEqual(snapshot(root), before);
      }
    });
  });
}

test('any live run under the legacy root refuses before destination checks, including dry run', async () => {
  await withTempTree('runs-move-live-', (root) => {
    const resolution = fixture(root);
    fs.mkdirSync(resolution.homeRoot, { recursive: true });
    fs.writeFileSync(path.join(resolution.homeRoot, 'existing'), 'keep');
    const dirs = [path.join(resolution.legacyRoot, 'project', 'one'), path.join(resolution.legacyRoot, 'other', 'two')];
    const before = snapshot(root);
    for (const dryRun of [false, true]) {
      let calls = 0;
      const result = runsMove({ resolution, dryRun, liveRuns: (scannedRoot) => {
        calls += 1;
        assert.equal(scannedRoot, resolution.legacyRoot);
        return dirs.map((dir) => ({ dir, status: { state: 'running' } }));
      } });
      assert.deepEqual(result, { exitCode: 1,
        output: `Runs are still live in ${resolution.legacyRoot}:\n${dirs.join('\n')}. Wait for them or stop them with codex-bridge stop, then repeat.` });
      assert.equal(calls, 1);
      assert.deepEqual(snapshot(root), before);
    }
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
          { exitCode: 1, output: `Run store destination is not an empty directory: ${homeRoot}.` });
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
    assert.deepEqual(result, { exitCode: 0,
      output: `Would copy 3 files (1.00 MB) in 2 folders from ${resolution.legacyRoot} to ${resolution.homeRoot}. Dry run: nothing changed.` });
    assert.deepEqual(snapshot(root), before);
    assert.equal(fs.existsSync(path.dirname(resolution.homeRoot)), false);
  });
});

test('copy reports verified records, preserves every legacy byte, and creates no move record', async () => {
  await withTempTree('runs-move-real-', (root) => {
    const resolution = fixture(root);
    const before = snapshot(resolution.legacyRoot);
    const result = runsMove({ resolution, liveRuns: () => [] });
    assert.deepEqual(result, { exitCode: 0,
      output: `Copied and verified 2 files (0.00 MB) from ${resolution.legacyRoot} to ${resolution.homeRoot}. The old folder is untouched; runs still write there until the move is completed.` });
    assert.deepEqual(snapshot(resolution.legacyRoot), before);
    assert.deepEqual(snapshot(resolution.homeRoot), before);
    assert.deepEqual(fs.readdirSync(path.dirname(resolution.homeRoot)), ['runs']);
    // B5a must leave the resolver switch to the next order (Plan_77 D7).
    assert.equal(fs.existsSync(path.join(root, 'home', 'state', 'runs-root.json')), false);
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
    assert.deepEqual(result, { exitCode: 1,
      output: `Cannot copy ${path.join(resolution.legacyRoot, 'project', 'events.jsonl')}\nNothing was switched; the old folder is untouched.` });
    assert.equal(fs.existsSync(resolution.homeRoot), false);
    assert.deepEqual(snapshot(resolution.legacyRoot), before);
  });
});

test('missing legacy source fails loudly with no switch or destination', async () => {
  await withTempTree('runs-move-missing-', (root) => {
    const resolution = { source: 'legacy', root: path.join(root, 'missing'),
      legacyRoot: path.join(root, 'missing'), homeRoot: path.join(root, 'home', 'runs') };
    const result = runsMove({ resolution, liveRuns: () => [] });
    assert.equal(result.exitCode, 1);
    assert.ok(result.output.includes(resolution.legacyRoot));
    assert.match(result.output, /Nothing was switched; the old folder is untouched\./);
    assert.deepEqual(fs.readdirSync(root), []);
  });
});
