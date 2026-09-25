import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeTempTree, removeTempTree } from './temp-tree.mjs';
import { transcriptHostVersion } from '../src/home/lib/host-version.mjs';

async function fixture(t) {
  const root = makeTempTree('bridge-host-version-');
  t.after(() => removeTempTree(root));
  return root;
}

test('returns the last entry carrying a version', async (t) => {
  const root = await fixture(t);
  const file = path.join(root, 'session.jsonl');
  await fs.writeFile(file, '{"version":"1.2.3"}\n{"message":"later"}\n{"version":"4.5.6"}\n');
  assert.equal(await transcriptHostVersion(file), '4.5.6');
});

test('skips a cut first tail line and reads versions from large transcript tails', async (t) => {
  const root = await fixture(t);
  const file = path.join(root, 'session.jsonl');
  await fs.writeFile(file, `${'x'.repeat(200)}\n{"version":"7.8.9"}\n`);
  assert.equal(await transcriptHostVersion(file, { tailBytes: 32 }), '7.8.9');
  await fs.appendFile(file, `${'z'.repeat(10000)}\n{"version":"6.5.4"}\n`);
  assert.equal(await transcriptHostVersion(file, { tailBytes: 64 }), '6.5.4');
});

test('returns null for missing files and transcripts without a version', async (t) => {
  const root = await fixture(t);
  const file = path.join(root, 'session.jsonl');
  assert.equal(await transcriptHostVersion(file), null);
  await fs.writeFile(file, '{"message":"none"}\nnot json\n');
  assert.equal(await transcriptHostVersion(file), null);
});
