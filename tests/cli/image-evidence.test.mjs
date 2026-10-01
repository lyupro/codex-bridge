/** Verifies the shared, read-only image content judgment required by Plan_65 D12. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { symlinkSync } from 'node:fs';
import path from 'node:path';
import { install } from '../../cli/install.mjs';
import { contentFingerprint, readInstallRecord, recordTarget } from '../../cli/manifest.mjs';
import { imagePackageIndex, judgeImageFile } from '../../cli/image-evidence.mjs';
import { resolveHost } from '../../cli/hosts.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

async function fixture(t) {
  const root = makeTempTree('bridge-image-evidence-');
  t.after(() => removeTempTree(root));
  const host = resolveHost({
    host: path.join(root, 'host'),
    codexHome: path.join(root, 'codex-home'),
    brandRoot: path.join(root, 'brand'),
  });
  await install({ host });
  const record = await readInstallRecord(host);
  const file = record.files.find((item) => item.root === 'brand' && item.path.startsWith('lib/'));
  assert.ok(file);
  const packageIndex = await imagePackageIndex(host);
  return { root, host, record, file, packageIndex, target: recordTarget(host, file) };
}

// D12 evidence is read-only: snapshot names and bytes without following junctions.
async function snapshot(root) {
  const entries = [];
  async function visit(folder) {
    const names = (await fs.readdir(folder)).sort();
    for (const name of names) {
      const target = path.join(folder, name);
      const relative = path.relative(root, target);
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink()) {
        entries.push([relative, 'link', await fs.readlink(target)]);
      } else if (stat.isDirectory()) {
        entries.push([relative, 'directory']);
        await visit(target);
      } else {
        entries.push([relative, 'file', await fs.readFile(target)]);
      }
    }
  }
  await visit(root);
  return entries;
}

async function judgeWithoutChanges(state, fingerprints) {
  const before = await snapshot(state.root);
  const result = await judgeImageFile(state.host, state.file, fingerprints, state.packageIndex);
  assert.deepEqual(await snapshot(state.root), before);
  return result;
}

test('unchanged image matches its recorded fingerprint without changing the tree', async (t) => {
  const state = await fixture(t);
  assert.equal(state.packageIndex.get(state.file.path).root, 'brand');
  assert.ok([...state.packageIndex].every(([key, item]) => item.root === 'brand' && key === item.relativeToRoot));
  const result = await judgeWithoutChanges(state, state.record.fingerprints);
  assert.equal(result.verdict, 'remove');
  assert.equal(result.reason, 'recorded');
});

test('undefined fingerprints fall back to package bytes without changing the tree', async (t) => {
  const state = await fixture(t);
  const before = await snapshot(state.root);
  const result = await judgeImageFile(state.host, state.file, undefined, state.packageIndex);
  assert.equal(result.verdict, 'remove');
  assert.equal(result.reason, 'package');
  assert.deepEqual(await snapshot(state.root), before);
});

test('edited image is kept as changed without changing the tree', async (t) => {
  const state = await fixture(t);
  await fs.writeFile(state.target, 'operator-edited image\n');
  const result = await judgeWithoutChanges(state, state.record.fingerprints);
  assert.equal(result.verdict, 'keep');
  assert.equal(result.reason, 'changed');
});

test('missing image is reported without changing the tree', async (t) => {
  const state = await fixture(t);
  await fs.unlink(state.target);
  const result = await judgeWithoutChanges(state, state.record.fingerprints);
  assert.equal(result.verdict, 'missing');
  assert.equal(result.reason, 'missing');
});

test('junction in place of an image is kept without touching its target or tree', async (t) => {
  const state = await fixture(t);
  await fs.unlink(state.target);
  const linkTarget = path.join(state.root, 'link-target');
  await fs.mkdir(linkTarget);
  const marker = path.join(linkTarget, 'marker.txt');
  const markerBytes = Buffer.from('link target remains\n');
  await fs.writeFile(marker, markerBytes);
  symlinkSync(linkTarget, state.target, 'junction');
  const result = await judgeWithoutChanges(state, state.record.fingerprints);
  assert.equal(result.verdict, 'keep');
  assert.equal(result.reason, 'link');
  assert.equal((await fs.lstat(state.target)).isSymbolicLink(), true);
  assert.deepEqual(await fs.readFile(marker), markerBytes);
});

test('recorded edits take precedence over package evidence', async (t) => {
  const state = await fixture(t);
  const edited = Buffer.from('operator edit now recorded\n');
  await fs.writeFile(state.target, edited);
  const fingerprints = { brand: { [state.file.path]: contentFingerprint(edited) } };
  // D10 item 3 accepts recorded bytes first; package content must not be read in this branch.
  state.packageIndex = { get() { throw new Error('Package evidence accessed after recorded match'); } };
  const result = await judgeWithoutChanges(state, fingerprints);
  assert.equal(result.verdict, 'remove');
  assert.equal(result.reason, 'recorded');
});

for (const method of ['lstat', 'readFile']) {
  test(`${method} failures take precedence over matching content and never change the tree`, async (t) => {
    const state = await fixture(t);
    for (const code of ['ENOENT', 'EACCES', undefined]) {
      const before = await snapshot(state.root);
      const original = fs[method];
      const mocked = t.mock.method(fs, method, async (target, ...args) => {
        if (target === state.target) throw Object.assign(new Error('simulated file error'), { code });
        return original(target, ...args);
      });
      let result;
      try {
        result = await judgeImageFile(state.host, state.file, state.record.fingerprints, state.packageIndex);
      } finally {
        mocked.mock.restore();
      }
      assert.equal(result.verdict, code === 'ENOENT' ? 'missing' : 'keep');
      assert.equal(result.reason, code === 'ENOENT' ? 'missing' : `unreadable: ${code ?? 'UNKNOWN'}`);
      assert.deepEqual(await snapshot(state.root), before);
    }
  });
}
