import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHomeWriter } from '../src/home/lib/home-write.mjs';
import { writeHomeJsonAtomic, writeJsonAtomic } from '../src/home/lib/atomic-json.mjs';
import { withTempTree } from './temp-tree.mjs';

function assertNoTemporary(directory) {
  assert.equal(fs.readdirSync(directory).some((name) => name.endsWith('.tmp')), false);
}

test('the raw atomic writer publishes complete JSON and removes its temporary', async () => {
  await withTempTree('atomic-json-raw-', async (root) => {
    const file = path.join(root, 'state', 'record.json');
    const record = { whole: true, count: 3 };
    writeJsonAtomic(file, record);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), record);
    assertNoTemporary(path.dirname(file));
  });
});

test('the home atomic writer publishes through its artifact id and removes its temporary', async () => {
  await withTempTree('atomic-json-home-', async (tree) => {
    const root = path.join(tree, 'home');
    const writer = createHomeWriter({ root });
    const file = path.join(root, 'state', 'handback-witness.json');
    const record = { host: 'codex', seen: true };
    writeHomeJsonAtomic(writer, 'handback-witness', file, record);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), record);
    assertNoTemporary(path.dirname(file));
  });
});

test('a failed raw rename rethrows and removes its temporary', async () => {
  await withTempTree('atomic-json-raw-rename-', async (root) => {
    const file = path.join(root, 'state', 'record.json');
    fs.mkdirSync(file, { recursive: true });
    assert.throws(() => writeJsonAtomic(file, { whole: true }));
    assertNoTemporary(path.dirname(file));
  });
});

test('a failed home rename rethrows and removes its temporary', async () => {
  await withTempTree('atomic-json-home-rename-', async (tree) => {
    const root = path.join(tree, 'home');
    const writer = createHomeWriter({ root });
    const file = path.join(root, 'state', 'handback-witness.json');
    fs.mkdirSync(file, { recursive: true });
    assert.throws(() => writeHomeJsonAtomic(writer, 'handback-witness', file, { whole: true }));
    assertNoTemporary(path.dirname(file));
  });
});

test('the home atomic writer rejects a mismatched id before creating the parent', async () => {
  await withTempTree('atomic-json-wrong-id-', async (tree) => {
    const root = path.join(tree, 'home');
    const writer = createHomeWriter({ root });
    const file = path.join(root, 'state', 'handback-witness.json');
    assert.throws(
      () => writeHomeJsonAtomic(writer, 'host-observations', file, { wrong: true }),
      { code: 'EHOMEREGISTRY' },
    );
    assert.throws(() => fs.statSync(path.join(root, 'state')), { code: 'ENOENT' });
  });
});
