/** Keeps the operator-checklist index and the checklist files describing the same set. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const docs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const checklistsDir = path.join(docs, 'checklists');
const indexFile = path.join(checklistsDir, 'operator-checklists.md');

// Checklists left the repository with Plan_36 — they are the operator's working notes, kept on disk
// and out of git. So the gate cannot assume the folder is there: on a fresh clone it is not, and a
// suite that goes red for everyone who clones the package teaches people to ignore it. Where the
// folder does exist — the operator's machine, where checklists are actually written — the rule is
// enforced exactly as before.
const present = fs.existsSync(indexFile);

// Only rendered links count. A link inside a fenced block or an HTML comment is invisible to the
// operator reading the page, so counting it would let the index look complete while it is not.
const index = present
  ? fs.readFileSync(indexFile, 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^```[\s\S]*?^```/gm, '')
  : '';

const checklists = () => {
  const found = [];
  for (const dir of ['.', 'done']) {
    const absolute = path.join(checklistsDir, dir);
    if (!fs.existsSync(absolute)) continue;
    for (const name of fs.readdirSync(absolute, { withFileTypes: true })) {
      if (!name.isFile() || !name.name.endsWith('.md')) continue;
      if (name.name === 'operator-checklists.md') continue;
      found.push(dir === '.' ? name.name : `${dir}/${name.name}`);
    }
  }
  return found;
};

test('every checklist file is listed in the index', { skip: present ? false : 'checklists are not in this clone' }, () => {
  const missing = checklists().filter((relative) => !index.includes(`(${relative})`));
  assert.deepEqual(
    missing,
    [],
    `not linked from docs/checklists/operator-checklists.md: ${missing.join(', ')}. A checklist `
      + 'nobody can find from the index is a checklist nobody runs.',
  );
});

test('every checklist link in the index resolves to a file', { skip: present ? false : 'checklists are not in this clone' }, () => {
  const linked = [...index.matchAll(/\]\(((?:done\/)?Plan_[^)]+\.md)\)/g)].map((hit) => hit[1]);
  assert.ok(linked.length, 'the index links to no checklist at all');
  const broken = linked.filter((relative) => !fs.existsSync(path.join(checklistsDir, relative)));
  assert.deepEqual(broken, [], `linked from the index but missing on disk: ${broken.join(', ')}`);
});
