/** Guards Plan_65 D4 item 4: uninstall must never unlink image files through a home junction. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { install } from '../../cli/install.mjs';
import { uninstall } from '../../cli/uninstall.mjs';
import { resolveHost } from '../../cli/hosts.mjs';
import { contentFingerprint, installRecordPath, readInstallRecord, recordTarget } from '../../cli/manifest.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

test('last-owner uninstall keeps a junction and all outside image bytes while removing the rest', async (t) => {
  const root = makeTempTree('bridge-uninstall-home-junction-');
  t.after(() => removeTempTree(root));
  const host = resolveHost({
    host: path.join(root, 'host'),
    codexHome: path.join(root, 'codex-home'),
    brandRoot: path.join(root, 'home'),
  });
  await install({ host });
  const record = await readInstallRecord(host);
  const relativeFolder = 'lib/runner';
  const movedFiles = record.files.filter((file) => file.root === 'brand'
    && file.path.startsWith(`${relativeFolder}/`));
  assert.ok(movedFiles.length > 0);
  const folder = path.join(host.brandRoot, relativeFolder);
  const outside = path.join(root, 'outside-runner');
  const originalEntries = (await fs.readdir(folder, { recursive: true })).sort();
  const originalBytes = new Map();
  for (const file of movedFiles) {
    const bytes = await fs.readFile(recordTarget(host, file));
    assert.equal(contentFingerprint(bytes), record.fingerprints.brand[file.path]);
    originalBytes.set(file.path, bytes);
  }
  await fs.rename(folder, outside);
  await fs.symlink(outside, folder, 'junction');

  const result = await uninstall({ host });

  assert.equal(result.exitCode, 0);
  assert.equal((await fs.lstat(folder)).isSymbolicLink(), true);
  assert.deepEqual((await fs.readdir(outside, { recursive: true })).sort(), originalEntries);
  for (const file of movedFiles) {
    const outsideFile = path.join(outside, file.path.slice(relativeFolder.length + 1));
    assert.deepEqual(await fs.readFile(outsideFile), originalBytes.get(file.path));
    assert.ok(result.output.split('\n').includes(`Left brand/${file.path} (link at ${relativeFolder})`));
  }
  for (const file of record.files.filter((entry) => !originalBytes.has(entry.path))) {
    await assert.rejects(() => fs.access(recordTarget(host, file)), { code: 'ENOENT' });
  }
  await assert.rejects(() => fs.access(installRecordPath(host)), { code: 'ENOENT' });
  assert.doesNotMatch(result.output, /^Removed brand\//m);
});
