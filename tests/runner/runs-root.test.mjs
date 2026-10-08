/** Guards Plan_77 D6/D7: no corrupt record may revive the store behind the $16.57 incident. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { retiredPathRefusal, runsRootResolution, staleOverrideRefusal } from '../../src/home/lib/runner/runs-root.mjs';
import {
  RUNS_MOVE_RECORD, readRunsMoveRecord, retiredRootOf, retiredRootRefusal, writeRunsMoveRecord,
} from '../../src/home/lib/runner/retired-roots.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

async function withHome(work) {
  const tree = makeTempTree('runs-root-');
  const homedir = path.join(tree, 'home');
  const brandHome = path.join(tree, 'brand');
  const env = { CODEX_BRIDGE_HOME: brandHome };
  const legacyRoot = path.join(homedir, '.claude', 'codex-runs');
  const homeRoot = path.join(brandHome, 'runs');
  const stateDir = path.join(brandHome, 'state');
  const file = path.join(stateDir, RUNS_MOVE_RECORD);
  const retired = [{ root: legacyRoot, movedAt: '2026-10-08T12:30:00.000Z' }];
  const record = { version: 1, retired };
  const writeRecord = (value = record) => {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  };
  try {
    await work({ tree, homedir, env, legacyRoot, homeRoot, stateDir, file, retired, record, writeRecord });
  } finally {
    await removeTempTree(tree);
  }
}

test('a clean home uses the default package root without creating anything', async () => {
  await withHome(({ tree, homedir, env, legacyRoot, homeRoot }) => {
    for (const override of [undefined, '', '   ']) {
      assert.deepEqual(runsRootResolution({ env: { ...env, CODEX_RUNS_ROOT: override }, homedir }), {
        root: homeRoot, source: 'default', legacyRoot, homeRoot, retired: [], staleOverride: null,
      });
    }
    assert.deepEqual(fs.readdirSync(tree), []);
  });
});

test('the default brand home is derived from the injected home', async () => {
  await withHome(({ homedir }) => {
    const result = runsRootResolution({ env: {}, homedir });
    assert.equal(result.root, path.join(homedir, '.lyupro', '.codex-bridge', 'runs'));
    assert.equal(result.source, 'default');
  });
});

test('an existing legacy directory stays active while the move is pending', async () => {
  await withHome(({ homedir, env, legacyRoot, homeRoot }) => {
    fs.mkdirSync(legacyRoot, { recursive: true });
    assert.deepEqual(runsRootResolution({ env, homedir }), {
      root: legacyRoot, source: 'legacy', legacyRoot, homeRoot, retired: [], staleOverride: null,
    });
    assert.equal(fs.existsSync(homeRoot), false);
  });
});

test('a legacy file is not a legacy directory', async () => {
  await withHome(({ homedir, env, legacyRoot, homeRoot }) => {
    fs.mkdirSync(path.dirname(legacyRoot), { recursive: true });
    fs.writeFileSync(legacyRoot, 'not a directory');
    assert.equal(runsRootResolution({ env, homedir }).source, 'default');
    assert.equal(runsRootResolution({ env, homedir }).root, homeRoot);
  });
});

test('a move record wins even while the legacy directory still exists', async () => {
  await withHome(({ homedir, env, legacyRoot, homeRoot, retired, writeRecord }) => {
    fs.mkdirSync(legacyRoot, { recursive: true });
    writeRecord();
    assert.deepEqual(runsRootResolution({ env, homedir }), {
      root: homeRoot, source: 'moved', legacyRoot, homeRoot, retired, staleOverride: null,
    });
    assert.equal(fs.existsSync(homeRoot), false);
  });
});

test('resolution reads the move record again on every call', async () => {
  await withHome(({ homedir, env, legacyRoot, writeRecord }) => {
    fs.mkdirSync(legacyRoot, { recursive: true });
    assert.equal(runsRootResolution({ env, homedir }).source, 'legacy');
    writeRecord();
    assert.equal(runsRootResolution({ env, homedir }).source, 'moved');
  });
});

test('a trimmed override wins over both the legacy store and a move record', async () => {
  await withHome(({ tree, homedir, env, legacyRoot, homeRoot, retired, writeRecord }) => {
    fs.mkdirSync(legacyRoot, { recursive: true });
    const root = path.join(tree, 'custom');
    const overridden = { ...env, CODEX_RUNS_ROOT: `  ${root}  ` };
    assert.equal(runsRootResolution({ env: overridden, homedir }).source, 'CODEX_RUNS_ROOT');
    writeRecord();
    assert.deepEqual(runsRootResolution({ env: overridden, homedir }), {
      root, source: 'CODEX_RUNS_ROOT', legacyRoot, homeRoot, retired, staleOverride: null,
    });
    assert.equal(fs.existsSync(root), false);
  });
});

test('an override under a retired root is reported without remapping or creating it', async () => {
  await withHome(({ homedir, env, legacyRoot, retired, writeRecord }) => {
    writeRecord();
    for (const suffix of ['', 'Project/Run-ID']) {
      const root = suffix ? path.join(legacyRoot, suffix) : legacyRoot;
      const result = runsRootResolution({ env: { ...env, CODEX_RUNS_ROOT: root }, homedir });
      assert.equal(result.root, root);
      assert.equal(result.source, 'CODEX_RUNS_ROOT');
      assert.deepEqual(result.retired, retired);
      assert.deepEqual(result.staleOverride, { root: legacyRoot, suffix });
      assert.equal(fs.existsSync(legacyRoot), false);
    }
  });
});

test('move record reading distinguishes absence from a valid list of retired roots', async () => {
  await withHome(({ tree, stateDir, record, writeRecord }) => {
    assert.equal(RUNS_MOVE_RECORD, 'runs-root.json');
    assert.equal(readRunsMoveRecord(stateDir), null);
    record.retired.push({ root: path.join(tree, 'earlier-runs'), movedAt: '2026-09-01T00:00:00Z' });
    writeRecord(record);
    assert.deepEqual(readRunsMoveRecord(stateDir), record);
    assert.deepEqual(retiredRootOf(path.join(tree, 'earlier-runs', 'Other', 'Run'), record.retired), {
      root: record.retired[1].root, suffix: 'Other/Run',
    });
  });
});

test('every corrupt record defect names the file and propagates even with an override', async () => {
  await withHome(({ tree, homedir, env, file, retired, writeRecord }) => {
    const cases = [
      ['{', /cannot parse/],
      ['null', /version/],
      [JSON.stringify({ version: 2, retired }), /version/],
      [JSON.stringify({ retired }), /version/],
      [JSON.stringify({ version: 1 }), /retired/],
      [JSON.stringify({ version: 1, retired: {} }), /retired/],
      [JSON.stringify({ version: 1, retired: [] }), /retired/],
      [JSON.stringify({ version: 1, retired: [null] }), /root.*absolute/],
      [JSON.stringify({ version: 1, retired: [{ ...retired[0], root: 'relative/runs' }] }), /root.*absolute/],
      [JSON.stringify({ version: 1, retired: [{ ...retired[0], root: 42 }] }), /root.*absolute/],
      [JSON.stringify({ version: 1, retired: [{ ...retired[0], movedAt: 'not a date' }] }), /movedAt/],
      [JSON.stringify({ version: 1, retired: [{ root: retired[0].root }] }), /movedAt/],
      [JSON.stringify({ version: 1, retired: [{ ...retired[0], movedAt: 0 }] }), /movedAt/],
      [JSON.stringify({ version: 1, retired: [retired[0], { root: 'bad' }] }), /retired\[1\].root/],
    ];
    writeRecord();
    for (const [text, defect] of cases) {
      fs.writeFileSync(file, text);
      const namesDefect = (error) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(file), error.message);
        assert.match(error.message, defect);
        return true;
      };
      assert.throws(() => readRunsMoveRecord(path.dirname(file)), namesDefect);
      for (const override of [undefined, path.join(tree, 'custom')]) {
        assert.throws(() => runsRootResolution({ env: { ...env, CODEX_RUNS_ROOT: override }, homedir }), namesDefect);
      }
    }
  });
});

test('retired root matching respects directory boundaries, spelling, and trailing slashes', async () => {
  await withHome(({ legacyRoot, retired }) => {
    for (const candidate of [undefined, null, 0, {}, '']) {
      assert.equal(retiredRootOf(candidate, retired), null);
    }
    assert.equal(retiredRootOf(`${legacyRoot}-old/Project`, retired), null);
    assert.equal(retiredRootOf(path.join(legacyRoot, 'Project'), []), null);
    assert.deepEqual(retiredRootOf(legacyRoot, retired), { root: legacyRoot, suffix: '' });
    assert.deepEqual(retiredRootOf(`${legacyRoot}/`, retired), { root: legacyRoot, suffix: '' });
    assert.deepEqual(retiredRootOf(`${legacyRoot}/Project/Run-ID/`, retired), {
      root: legacyRoot, suffix: 'Project/Run-ID',
    });
    const trailing = [{ ...retired[0], root: `${legacyRoot}/` }];
    assert.deepEqual(retiredRootOf(path.join(legacyRoot, 'Project'), trailing), {
      root: `${legacyRoot}/`, suffix: 'Project',
    });
    if (process.platform === 'win32') {
      const root = 'C:\\Users\\u\\.claude\\codex-runs';
      assert.deepEqual(retiredRootOf('c:\\USERS\\U\\.CLAUDE\\CODEX-RUNS\\MyProject\\Run-ID\\', [{ root }]), {
        root, suffix: 'MyProject/Run-ID',
      });
      assert.equal(retiredRootOf('c:\\users\\u\\.claude\\codex-runs-old', [{ root }]), null);
      assert.deepEqual(retiredRootOf('c:/USERS/u/.CLAUDE/CODEX-RUNS/', [{ root }]), { root, suffix: '' });
    }
  });
});

test('retired root refusal gives the exact new address with and without a suffix', async () => {
  await withHome(({ legacyRoot, homeRoot }) => {
    for (const suffix of ['', 'Project/Run-ID']) {
      const candidate = path.join(legacyRoot, suffix);
      const equivalent = suffix ? path.join(homeRoot, suffix) : homeRoot;
      assert.equal(retiredRootRefusal({ candidate, retired: { root: legacyRoot, suffix }, destination: homeRoot }),
        `Run records moved from ${legacyRoot} to ${homeRoot}. Equivalent path: ${equivalent}. ` +
        'Update advice: or pass this new path explicitly. No path was remapped.');
    }
  });
});

test('retiredPathRefusal returns null outside retired roots and the exact equivalent address inside', async () => {
  await withHome(({ tree, homedir, env, legacyRoot, homeRoot, record, writeRecord }) => {
    const earlierRoot = path.join(tree, 'earlier-runs');
    record.retired.push({ root: earlierRoot, movedAt: '2026-09-01T00:00:00Z' });
    writeRecord(record);
    const resolution = runsRootResolution({ env, homedir });
    for (const candidate of [null, '', homeRoot, `${legacyRoot}-old`]) {
      assert.equal(retiredPathRefusal(candidate, resolution), null);
    }
    assert.equal(retiredPathRefusal(legacyRoot, { ...resolution, retired: [] }), null);
    for (const root of [legacyRoot, earlierRoot]) {
      for (const suffix of ['', 'Project/Run-ID']) {
        const candidate = path.join(root, suffix);
        assert.equal(retiredPathRefusal(candidate, resolution),
          `Run records moved from ${root} to ${homeRoot}. Equivalent path: ${path.join(homeRoot, suffix)}. ` +
          'Update advice: or pass this new path explicitly. No path was remapped.');
      }
      assert.equal(fs.existsSync(root), false);
    }
    assert.equal(fs.existsSync(homeRoot), false);
  });
});

test('staleOverrideRefusal returns null for current roots and names a stale override without remapping', async () => {
  await withHome(({ tree, homedir, env, legacyRoot, homeRoot, writeRecord }) => {
    writeRecord();
    for (const override of [undefined, homeRoot, path.join(tree, 'custom')]) {
      assert.equal(staleOverrideRefusal(runsRootResolution({
        env: { ...env, CODEX_RUNS_ROOT: override }, homedir,
      })), null);
    }
    for (const suffix of ['', 'Project/Run-ID']) {
      const root = path.join(legacyRoot, suffix);
      const resolution = runsRootResolution({ env: { ...env, CODEX_RUNS_ROOT: `  ${root}  ` }, homedir });
      assert.equal(staleOverrideRefusal(resolution),
        `Run records moved from ${legacyRoot} to ${homeRoot}. Equivalent path: ${path.join(homeRoot, suffix)}. ` +
        'Update advice: or pass this new path explicitly. No path was remapped.\n' +
        'CODEX_RUNS_ROOT points under a retired runs root; remove it or set it to the new location.');
      assert.equal(resolution.root, root);
    }
    assert.equal(fs.existsSync(legacyRoot), false);
    assert.equal(fs.existsSync(homeRoot), false);
  });
});

test('the move record is published atomically, read back, and appended on a later move (Plan_77 D7)', async () => {
  await withHome(({ homedir, env, legacyRoot, homeRoot, stateDir }) => {
    fs.mkdirSync(legacyRoot, { recursive: true });
    assert.equal(runsRootResolution({ env, homedir }).source, 'legacy');
    const first = writeRunsMoveRecord(stateDir, { root: legacyRoot, movedAt: '2026-10-08T13:00:00.000Z' });
    assert.deepEqual(readRunsMoveRecord(stateDir), first);
    const resolution = runsRootResolution({ env, homedir });
    assert.equal(resolution.source, 'moved');
    assert.equal(resolution.root, homeRoot);
    const later = path.join(path.dirname(homeRoot), 'older-runs');
    writeRunsMoveRecord(stateDir, { root: later, movedAt: '2026-10-09T13:00:00.000Z' });
    assert.deepEqual(readRunsMoveRecord(stateDir).retired.map(({ root }) => root), [legacyRoot, later]);
    assert.deepEqual(fs.readdirSync(stateDir), [RUNS_MOVE_RECORD]);
  });
});
