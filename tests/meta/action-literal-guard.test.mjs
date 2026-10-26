/**
 * OW-075 A6c: the standalone row is the only place the Action: token may appear.
 * External text (Codex errors, model summaries) is always printed behind a FAIL — or > prefix
 * and cannot form a row, so no runtime filter is added without a proven failure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../src/home/', import.meta.url));
const allowed = ['lib/order-diagnostics/next-action.mjs', 'lib/runner/args.mjs'];

function actionOccurrences() {
  const occurrences = [];
  for (const file of fs.readdirSync(root, { recursive: true })) {
    if (!file.endsWith('.mjs')) continue;
    const relative = file.split(path.sep).join('/');
    const lines = fs.readFileSync(path.join(root, file), 'utf8').split('\n');
    for (const [index, line] of lines.entries()) {
      for (const match of line.matchAll(/Action:/g)) {
        occurrences.push({ file: relative, line: index + 1, column: match.index + 1 });
      }
    }
  }
  return occurrences;
}

test('Action: literals under src/home occur only in the standalone-row modules', () => {
  const offenders = actionOccurrences().filter(({ file }) => !allowed.includes(file));
  assert.deepEqual(offenders, [], offenders.map(({ file, line, column }) =>
    `src/home/${file}:${line}:${column}: unexpected Action: literal`).join('\n'));
});

test('Action: literal walk finds known occurrences in both standalone-row modules', () => {
  const occurrences = actionOccurrences();
  for (const file of allowed) {
    assert.ok(occurrences.filter((entry) => entry.file === file).length > 0,
      `src/home/${file}: expected at least one Action: literal`);
  }
});
