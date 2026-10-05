/**
 * Plan_63 D7: runner refusals and replies obtain order-input spellings from the schema, so
 * changing the input channel only changes orderInputName instead of leaving stale instructions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSpellings, orderSpellings } from '../order-spelling-scan.mjs';

const LIB = fileURLToPath(new URL('../../src/home/lib/', import.meta.url));

function scan(source, file) {
  return findSpellings(source, file).map(({ file, line, spelling }) =>
    `${file}:${line}: ${spelling} — use orderInputName(label)`);
}

function moduleFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return moduleFiles(file);
    return entry.isFile() && entry.name.endsWith('.mjs') ? [file] : [];
  });
}

test('runner and meta code take every order-input spelling from the schema', () => {
  const findings = ['runner', 'meta'].flatMap((directory) =>
    moduleFiles(path.join(LIB, directory)).flatMap((file) => {
      const relative = path.relative(LIB, file).split(path.sep).join('/');
      // Plan_63 D8: the closed argv parser must not restore an order flag either.
      return scan(fs.readFileSync(file, 'utf8'), `src/home/lib/${relative}`);
    }),
  );
  assert.deepEqual(findings, [], findings.join('\n'));
});

test('the scanner reports code spellings, ignores comments and respects whole flags', () => {
  const [spelling] = orderSpellings();
  assert.deepEqual(scan(`// header\nconst input = '${spelling}';`, 'inline.mjs'), [
    `inline.mjs:2: ${spelling} — use orderInputName(label)`,
  ]);
  assert.deepEqual(scan(`// ${spelling}\n/* ${spelling}\n${spelling} */`, 'inline.mjs'), []);
  assert.deepEqual(scan(`/* ${spelling}\n*/\nconst input = '${spelling}';`, 'inline.mjs'), [
    `inline.mjs:3: ${spelling} — use orderInputName(label)`,
  ]);
  assert.deepEqual(scan(`const input = '${spelling} // still code';`, 'inline.mjs'), [
    `inline.mjs:1: ${spelling} — use orderInputName(label)`,
  ]);
  const scope = orderSpellings().find((flag) => flag.endsWith('scope'));
  const scopeNew = orderSpellings().find((flag) => flag.endsWith('scope-new'));
  assert.deepEqual(scan(`'${scopeNew}'`, 'inline.mjs'), [
    `inline.mjs:1: ${scopeNew} — use orderInputName(label)`,
  ]);
  assert.deepEqual(scan(`'${scope}d' '${scope}-extra' '${scope}1' '${scope}A'`, 'inline.mjs'), []);
});

test('header labels are not flag spellings: reply text may name scope and phase', () => {
  // Plan_63 D8: scanning labels would mistake ordinary replies for a retired argv channel.
  assert.deepEqual(scan("const reply = 'OK — scope: sufficient; continue this run with `phase:` advise';",
    'inline.mjs'), []);
});
