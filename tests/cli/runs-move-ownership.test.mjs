/** Plan_77 F1: a move removes only the staging folder or store it created, and rechecks before it switches. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { readRunsMoveRecord } from '../../src/home/lib/runner/retired-roots.mjs';
import { runsMove } from '../../cli/runs-move.mjs';
import { withTempTree } from '../temp-tree.mjs';
import { fixture, snapshot } from './runs-move-fixtures.mjs';

// Plan_77 F1 findings 1/3/6: each failure cleans only owned staging/publication, before D7.
for (const failure of ['competitor', 'late-file', 'changed-byte', 'live-run', 'rename', 'filled-empty', 'record']) {
  test(`${failure} during move refuses without losing records or leaving staging`, async (t) => {
    await withTempTree('runs-move-f1-', (root) => {
      const resolution = fixture(root);
      const before = snapshot(resolution.legacyRoot);
      let scans = 0;
      let imported = false;
      if (failure === 'filled-empty') {
        fs.mkdirSync(resolution.homeRoot, { recursive: true });
        const rmdir = fs.rmdirSync;
        t.mock.method(fs, 'rmdirSync', (dir, ...args) => {
          if (dir === resolution.homeRoot) fs.writeFileSync(path.join(dir, 'winner'), 'keep');
          return rmdir(dir, ...args);
        });
      }
      if (failure === 'rename') {
        t.mock.method(fs, 'renameSync', () => { throw new Error('Publish rename failed'); });
      }
      if (failure === 'record') {
        const write = fs.writeFileSync;
        t.mock.method(fs, 'writeFileSync', (file, ...args) => {
          if (String(file).startsWith(resolution.stateDir)) {
            assert.ok(fs.existsSync(resolution.homeRoot), 'publish precedes record');
            throw new Error('Record write failed');
          }
          return write(file, ...args);
        });
      }
      const result = runsMove({ resolution, liveRuns: () => {
        scans += 1;
        if (scans === 2) assert.ok(imported, 'recheck follows history import');
        return failure === 'live-run' && scans === 2 ? [{ dir: 'new-live-run' }] : [];
      }, importHistory: ({ to }) => {
        imported = true;
        assert.ok(to.startsWith(`${resolution.homeRoot}.moving-`));
        assert.deepEqual(snapshot(to), before);
        if (failure === 'competitor') {
          fs.mkdirSync(resolution.homeRoot);
          fs.writeFileSync(path.join(resolution.homeRoot, 'winner'), 'keep');
        }
        if (failure === 'late-file') fs.writeFileSync(path.join(resolution.legacyRoot, 'late'), 'keep');
        if (failure === 'changed-byte') fs.writeFileSync(path.join(resolution.legacyRoot, '.project.json'), '[]');
        return { imported: false, reason: 'not in git' };
      } });
      assert.equal(result.exitCode, 1, result.output);
      assert.match(result.output, /Nothing was switched/);
      assert.equal(scans, 2);
      if (failure === 'record') assert.match(result.output, /Record write failed/);
      if (failure === 'rename') assert.match(result.output, /Publish rename failed/);
      assert.equal(readRunsMoveRecord(resolution.stateDir), null);
      assert.ok(!fs.readdirSync(path.dirname(resolution.homeRoot)).some(name => name.includes('.moving-')));
      if (['competitor', 'filled-empty'].includes(failure)) {
        assert.equal(fs.readFileSync(path.join(resolution.homeRoot, 'winner'), 'utf8'), 'keep');
      } else assert.equal(fs.existsSync(resolution.homeRoot), false);
      if (['late-file', 'changed-byte', 'live-run'].includes(failure)) {
        assert.match(result.output, /A run started or a record changed during the move/);
        assert.match(result.output, /repeat when no project is running/);
      }
      if (failure === 'late-file') assert.equal(fs.readFileSync(path.join(resolution.legacyRoot, 'late'), 'utf8'), 'keep');
      else if (failure === 'changed-byte') assert.equal(fs.readFileSync(path.join(resolution.legacyRoot, '.project.json'), 'utf8'), '[]');
      else assert.deepEqual(snapshot(resolution.legacyRoot), before);
    });
  });
}

test('a pre-existing empty home is replaced only after history and verification', async () => {
  await withTempTree('runs-move-empty-home-', (root) => {
    const resolution = fixture(root);
    fs.mkdirSync(resolution.homeRoot, { recursive: true });
    const result = runsMove({ resolution, liveRuns: () => [], importHistory: () => {
      assert.deepEqual(fs.readdirSync(resolution.homeRoot), []);
      return { imported: false, reason: 'not in git' };
    } });
    assert.equal(result.exitCode, 0, result.output);
    assert.deepEqual(snapshot(resolution.homeRoot), snapshot(resolution.legacyRoot));
  });
});

test('exclusive staging creation refuses a collision without deleting the other staging folder', async (t) => {
  await withTempTree('runs-move-staging-collision-', (root) => {
    const resolution = fixture(root);
    t.mock.method(Date, 'now', () => 77);
    const staging = `${resolution.homeRoot}.moving-${process.pid}-77`;
    fs.mkdirSync(path.dirname(staging), { recursive: true });
    fs.mkdirSync(staging);
    fs.writeFileSync(path.join(staging, 'winner'), 'keep');
    const before = snapshot(root);
    const result = runsMove({ resolution, liveRuns: () => [],
      importHistory: () => assert.fail('staging collision must refuse before importing') });
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /EEXIST/);
    assert.deepEqual(snapshot(root), before);
    assert.equal(readRunsMoveRecord(resolution.stateDir), null);
  });
});
