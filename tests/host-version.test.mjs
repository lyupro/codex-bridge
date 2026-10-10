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

test('only credits the requested session while preserving the old call shape', async (t) => {
  const root = await fixture(t);
  const file = path.join(root, 'session.jsonl');
  await fs.writeFile(file, [
    { sessionId: 'wanted', version: '1.2.3' },
    { sessionId: 'other', version: '4.5.6' },
    { version: '7.8.9' },
  ].map((entry) => JSON.stringify(entry)).join('\n'));
  assert.equal(await transcriptHostVersion(file, { sessionId: 'wanted' }), '1.2.3');
  assert.equal(await transcriptHostVersion(file, { sessionId: 'missing' }), null);
  assert.equal(await transcriptHostVersion(file), '7.8.9');
  assert.equal(await transcriptHostVersion(file, { tailBytes: 65536 }), '7.8.9');
  assert.equal(await transcriptHostVersion(file, { sessionId: '' }), '7.8.9');
});

test('a finished session whose tail is one huge line still names its host from the head', async (t) => {
  const root = await fixture(t);
  const file = path.join(root, 'finished.jsonl');
  await fs.writeFile(file, [
    { sessionId: 'other', version: '9.9.9' },
    { type: 'user', sessionId: 'wanted', version: '2.1.296' },
    { type: 'attachment', sessionId: 'wanted', content: 'x'.repeat(140000) },
    { type: 'last-prompt', sessionId: 'wanted' },
  ].map((entry) => JSON.stringify(entry)).join('\n'));
  assert.equal(await transcriptHostVersion(file, { sessionId: 'wanted' }), '2.1.296');
  assert.equal(await transcriptHostVersion(file, { sessionId: 'absent' }), null);
  assert.equal(await transcriptHostVersion(file), null);
});

test('a transcript with only another session never identifies the requested session', async (t) => {
  const root = await fixture(t);
  const file = path.join(root, 'session.jsonl');
  await fs.writeFile(file, '{"sessionId":"other","version":"4.5.6"}\n');
  assert.equal(await transcriptHostVersion(file, { sessionId: 'wanted' }), null);
});
