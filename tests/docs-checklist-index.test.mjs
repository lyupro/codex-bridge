/** Keeps the operator-checklist index and the checklist files describing the same set. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const docs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const indexFile = path.join(docs, 'operator-checklists.md');

// Only rendered links count. A link inside a fenced block or an HTML comment is invisible to the
// operator reading the page, so counting it would let the index look complete while it is not.
const index = fs.readFileSync(indexFile, 'utf8')
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/^```[\s\S]*?^```/gm, '');

const checklists = () => {
  const found = [];
  for (const dir of ['checklists', path.join('checklists', 'done')]) {
    for (const name of fs.readdirSync(path.join(docs, dir), { withFileTypes: true })) {
      if (name.isFile() && name.name.endsWith('.md')) found.push(`${dir.replace(/\\/g, '/')}/${name.name}`);
    }
  }
  return found;
};

test('every checklist file is listed in the index', () => {
  const missing = checklists().filter((relative) => !index.includes(`(${relative})`));
  assert.deepEqual(
    missing,
    [],
    `not linked from docs/operator-checklists.md: ${missing.join(', ')}. A checklist nobody can find `
      + 'from the index is a checklist nobody runs.',
  );
});

test('every checklist link in the index resolves to a file', () => {
  const linked = [...index.matchAll(/\]\((checklists\/[^)]+\.md)\)/g)].map((hit) => hit[1]);
  assert.ok(linked.length, 'the index links to no checklist at all');
  const broken = linked.filter((relative) => !fs.existsSync(path.join(docs, relative)));
  assert.deepEqual(broken, [], `linked from the index but missing on disk: ${broken.join(', ')}`);
});
