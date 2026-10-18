/** Plan_80 E18: keep reads of the recovery relationship in its two owners. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../../', import.meta.url));
const recoveryRead = /\.recovery\b(?!_)|\[\s*['"`]recovery['"`]\s*\]/;
const owners = new Set([
  'src/home/lib/meta/recovery-successor.mjs',
  'src/home/lib/meta/pre-start.mjs',
]);

function modules(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? modules(file) : entry.name.endsWith('.mjs') ? [file] : [];
  });
}

test('the recovery owner expression recognizes direct and optional reads only', () => {
  assert.equal(recoveryRead.test('status.recovery'), true);
  assert.equal(recoveryRead.test('status?.recovery?.child'), true);
  assert.equal(recoveryRead.test("status['recovery']"), true);
  assert.equal(recoveryRead.test('order.recovery_policy'), false);
  assert.equal(recoveryRead.test("Object.hasOwn(status, 'recovery')"), false);
});

test('only the E18 resolver and pre-start marker read the recovery relationship', () => {
  const hits = [];
  for (const source of ['src', 'cli']) {
    for (const file of modules(path.join(root, source))) {
      const relative = path.relative(root, file).split(path.sep).join('/');
      if (owners.has(relative)) continue;
      fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, index) => {
        if (recoveryRead.test(line)) hits.push(`${relative}:${index + 1}`);
      });
    }
  }
  assert.deepEqual(hits, [], `Recovery relationship reads outside its owners: ${hits.join(', ')}`);
});
