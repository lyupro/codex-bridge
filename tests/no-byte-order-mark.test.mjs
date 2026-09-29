/**
 * 2026-09-30: acceptance of Plan_71 B1 found a UTF-8 byte order mark at the start of both files the
 * delegated run wrote, and a search found two more committed by an earlier run (Plan_65 B13a,
 * `cli/lifecycle-lock.mjs` and its test). Nothing reads the mark as harmful today, but it rides into the
 * installed home and into diffs as an invisible first-line change, and it came from the executor, not
 * from a decision. Every tracked file is checked, because the executor writes more than source.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BYTE_ORDER_MARK = Buffer.from([0xef, 0xbb, 0xbf]);

function trackedFiles() {
  const listed = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(listed.status, 0, `git ls-files failed: ${listed.stderr}`);
  return listed.stdout.split('\0').filter(Boolean);
}

function startsWithMark(file) {
  const handle = fs.openSync(path.join(root, file), 'r');
  try {
    const head = Buffer.alloc(BYTE_ORDER_MARK.length);
    const read = fs.readSync(handle, head, 0, head.length, 0);
    return read === head.length && head.equals(BYTE_ORDER_MARK);
  } finally {
    fs.closeSync(handle);
  }
}

test('no tracked file starts with a UTF-8 byte order mark', () => {
  const files = trackedFiles().filter((file) => fs.existsSync(path.join(root, file)));
  assert.ok(files.length > 100, `expected the repository's tracked files, got ${files.length}`);
  assert.deepEqual(files.filter(startsWithMark), []);
});
