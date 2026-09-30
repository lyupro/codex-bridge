import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { snapshotRoot, addedEntries } from '../scripts/root-guard/root-entries.mjs';
import { withTempTree } from './temp-tree.mjs';

test('snapshotRoot returns sorted direct files and directories only', async () => {
  await withTempTree('root-guard-', (dir) => {
    fs.writeFileSync(path.join(dir, 'z-file'), '');
    fs.mkdirSync(path.join(dir, 'a-directory'));
    fs.writeFileSync(path.join(dir, 'a-directory', 'nested-file'), '');
    assert.deepEqual(snapshotRoot(dir), ['a-directory', 'z-file']);
  });
});

test('snapshotRoot includes dot-entries', async () => {
  await withTempTree('root-guard-', (dir) => {
    fs.writeFileSync(path.join(dir, '.hidden-file'), '');
    fs.mkdirSync(path.join(dir, '.hidden-directory'));
    assert.deepEqual(snapshotRoot(dir), ['.hidden-directory', '.hidden-file']);
  });
});

test('snapshotRoot includes entries covered by a gitignore rule', async () => {
  await withTempTree('root-guard-', (dir) => {
    fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored-entry/\n');
    fs.mkdirSync(path.join(dir, 'ignored-entry'));
    assert.deepEqual(snapshotRoot(dir), ['.gitignore', 'ignored-entry']);
  });
});

test('addedEntries names new files and directories including dot and ignored entries', async () => {
  await withTempTree('root-guard-', (dir) => {
    fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored-entry/\n');
    const before = snapshotRoot(dir);
    fs.writeFileSync(path.join(dir, 'new-file'), '');
    fs.writeFileSync(path.join(dir, '.new-hidden-file'), '');
    fs.mkdirSync(path.join(dir, 'ignored-entry'));
    assert.deepEqual(addedEntries(before, snapshotRoot(dir)), [
      '.new-hidden-file', 'ignored-entry', 'new-file',
    ]);
  });
});

test('addedEntries does not treat a removal as an addition', async () => {
  await withTempTree('root-guard-', (dir) => {
    fs.writeFileSync(path.join(dir, 'removed-file'), '');
    const before = snapshotRoot(dir);
    fs.unlinkSync(path.join(dir, 'removed-file'));
    assert.deepEqual(addedEntries(before, snapshotRoot(dir)), []);
  });
});

test('addedEntries returns nothing for identical snapshots', async () => {
  await withTempTree('root-guard-', (dir) => {
    fs.writeFileSync(path.join(dir, 'existing-file'), '');
    assert.deepEqual(addedEntries(snapshotRoot(dir), snapshotRoot(dir)), []);
  });
});
