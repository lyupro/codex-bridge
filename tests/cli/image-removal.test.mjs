/** Verifies Plan_65 D10 item 3 protects image edits during uninstall. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { install } from '../../cli/install.mjs';
import { installRecordPath, readInstallRecord, recordTarget } from '../../cli/manifest.mjs';
import { removeImageFiles } from '../../cli/image-removal.mjs';
import { contentFingerprint } from '../../cli/manifest.mjs';
import { resolveHost } from '../../cli/hosts.mjs';
import { uninstall } from '../../cli/uninstall.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

async function fixture(t) {
  const root = makeTempTree('bridge-image-removal-');
  t.after(() => removeTempTree(root));
  const host = resolveHost({
    host: path.join(root, 'host'),
    codexHome: path.join(root, 'codex-home'),
    brandRoot: path.join(root, 'brand'),
  });
  await install({ host });
  const record = await readInstallRecord(host);
  const imageFiles = record.files.filter((file) => file.root === 'brand');
  const libFile = imageFiles.find((file) => file.path.startsWith('lib/'));
  assert.ok(libFile);
  return { root, host, record, imageFiles, libFile, target: recordTarget(host, libFile) };
}

test('unchanged image file is removed', async (t) => {
  const state = await fixture(t);
  const result = await removeImageFiles(state.host, [state.libFile], state.record.fingerprints);
  assert.deepEqual(result.lines, [`Removed brand/${state.libFile.path}`]);
  await assert.rejects(() => fs.access(state.target), { code: 'ENOENT' });
});

test('edited image file is kept and named as changed', async (t) => {
  const state = await fixture(t);
  const edited = Buffer.from('operator-edited image\n');
  await fs.writeFile(state.target, edited);
  const result = await removeImageFiles(state.host, [state.libFile], state.record.fingerprints);
  assert.deepEqual(result.lines, [`Left brand/${state.libFile.path} (changed)`]);
  assert.deepEqual(await fs.readFile(state.target), edited);
});

test('edited image file is removed when its recorded fingerprint matches the edit', async (t) => {
  const state = await fixture(t);
  const edited = Buffer.from('operator edit now recorded\n');
  await fs.writeFile(state.target, edited);
  const fingerprints = { brand: { [state.libFile.path]: contentFingerprint(edited) } };
  const result = await removeImageFiles(state.host, [state.libFile], fingerprints);
  assert.deepEqual(result.lines, [`Removed brand/${state.libFile.path}`]);
  await assert.rejects(() => fs.access(state.target), { code: 'ENOENT' });
});

test('missing fingerprints still allow removal when bytes match the current package', async (t) => {
  const state = await fixture(t);
  const result = await removeImageFiles(state.host, [state.libFile], undefined);
  assert.deepEqual(result.lines, [`Removed brand/${state.libFile.path}`]);
  await assert.rejects(() => fs.access(state.target), { code: 'ENOENT' });
});

test('missing image file produces no line', async (t) => {
  const state = await fixture(t);
  await fs.unlink(state.target);
  const result = await removeImageFiles(state.host, [state.libFile], state.record.fingerprints);
  assert.deepEqual(result.lines, []);
});

test('dry run reports removal and preservation without changing files', async (t) => {
  const state = await fixture(t);
  const changed = state.imageFiles.find((file) => file.path !== state.libFile.path);
  assert.ok(changed);
  const changedTarget = recordTarget(state.host, changed);
  const changedBytes = Buffer.from('dry-run edit\n');
  await fs.writeFile(changedTarget, changedBytes);
  const originalBytes = await fs.readFile(state.target);
  const result = await removeImageFiles(state.host, [state.libFile, changed], state.record.fingerprints, { dryRun: true });
  assert.ok(result.lines.includes(`Would remove brand/${state.libFile.path}`));
  assert.ok(result.lines.includes(`Would leave brand/${changed.path} (changed)`));
  assert.deepEqual(await fs.readFile(state.target), originalBytes);
  assert.deepEqual(await fs.readFile(changedTarget), changedBytes);
});

test('symbolic link in place of image file is kept and its target remains untouched', async (t) => {
  const state = await fixture(t);
  await fs.unlink(state.target);
  const linkTarget = path.join(state.root, 'link-target');
  await fs.mkdir(linkTarget);
  const marker = path.join(linkTarget, 'marker.txt');
  const markerBytes = Buffer.from('link target remains\n');
  await fs.writeFile(marker, markerBytes);
  await fs.symlink(linkTarget, state.target, 'junction');
  const result = await removeImageFiles(state.host, [state.libFile], state.record.fingerprints);
  assert.deepEqual(result.lines, [`Left brand/${state.libFile.path} (link)`]);
  assert.equal((await fs.lstat(state.target)).isSymbolicLink(), true);
  assert.deepEqual(await fs.readFile(marker), markerBytes);
});

test('uninstall of the last owner preserves an edited lib file and removes the record', async (t) => {
  const state = await fixture(t);
  const edited = Buffer.from('edited after install\n');
  await fs.writeFile(state.target, edited);
  const result = await uninstall({ host: state.host });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(await fs.readFile(state.target), edited);
  assert.ok(result.output.includes(`Left brand/${state.libFile.path} (changed)`));
  assert.match(result.output, /^Removed \d+ image file\(s\) from /m);
  assert.doesNotMatch(result.output, /^Removed brand\//m);
  await assert.rejects(() => fs.access(installRecordPath(state.host)), { code: 'ENOENT' });
});
