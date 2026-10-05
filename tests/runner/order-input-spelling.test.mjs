/**
 * Plan_63 D7/D9: hooks and dispatcher commands join the runner guard at C3/C4, so
 * retired command-line inputs cannot return when orders move into task-file headers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSpellings, orderSpellings } from '../order-spelling-scan.mjs';

const HOME = fileURLToPath(new URL('../../src/home/', import.meta.url));
// Plan_63 D9: the host-refusal recognizer must read historical refusal text, never emit an order flag.
const ALLOW_LIST = new Map([
  ['src/home/lib/host-refusal.mjs', 'Recognizes the retired order-id spelling in a host refusal transcript.'],
]);

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

test('all library and hook code keep retired order flags dead', () => {
  const findings = ['lib', 'hooks'].flatMap((directory) =>
    moduleFiles(path.join(HOME, directory)).flatMap((file) => {
      const relative = `src/home/${path.relative(HOME, file).split(path.sep).join('/')}`;
      if (ALLOW_LIST.has(relative)) {
        assert.ok(ALLOW_LIST.get(relative).trim(), `${relative}: an exception needs a reason`);
        return [];
      }
      // Plan_63 D8: the closed argv parser must not restore an order flag either.
      return scan(fs.readFileSync(file, 'utf8'), relative);
    }),
  );
  assert.deepEqual(findings, [], findings.join('\n'));
});

test('the negative inventory is exactly the nine frozen retired order flags', () => {
  assert.deepEqual(orderSpellings(), [
    'order-id', 'scope', 'scope-new', 'repo', 'slug', 'effort', 'changeset', 'phase', 'continue',
  ].map((name) => `--${name}`));
  assert.ok(Object.isFrozen(orderSpellings()));
  assert.throws(() => orderSpellings().push('--invented'), TypeError);
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

test('regex quotes do not turn following comments into code or hide real flags', () => {
  const [spelling] = orderSpellings();
  const regex = "/[\x60\"'*]+$/g";
  const source = regex + '\n/** ' + spelling + ' */\nconst input = "' + spelling + '";';
  assert.deepEqual(scan(source, 'inline.mjs'), [
    `inline.mjs:3: ${spelling} — use orderInputName(label)`,
  ]);
  assert.deepEqual(scan('/' + spelling + '/i', 'inline.mjs'), [
    `inline.mjs:1: ${spelling} — use orderInputName(label)`,
  ]);
});

test('header labels are not flag spellings: reply text may name scope and phase', () => {
  // Plan_63 D8: scanning labels would mistake ordinary replies for a retired argv channel.
  assert.deepEqual(scan("const reply = 'OK — scope: sufficient; continue this run with `phase:` advise';",
    'inline.mjs'), []);
});
