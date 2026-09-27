/**
 * Plan_69 stage 0: `run-config.mjs` read a config it could not open (EACCES, EISDIR) as "no config"
 * because it tested `if (err.code)` — any error code — and every role then ran on default models
 * unseen. A reader that means "the file is missing" says `err.code === 'ENOENT'`; this guard fails
 * on the shape that treats every failure as absence, so the next reader cannot repeat it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOTS = ['bin', 'cli', 'scripts', 'src'];
// `if (err.code) return …` / `if (error.code) { return …` with no comparison on the code.
const ANY_CODE_IS_ABSENCE = /if\s*\(\s*!?\s*\w+\.code\s*\)\s*\{?\s*return\b/;

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return entry.isFile() && /\.[cm]?js$/.test(entry.name) ? [file] : [];
  });
}

test('no reader treats every error code as a missing file', () => {
  const offenders = ROOTS.flatMap((dir) => sourceFiles(path.join(root, dir)))
    .flatMap((file) => fs.readFileSync(file, 'utf8').split(/\r?\n/)
      .map((line, index) => [line, index + 1])
      .filter(([line]) => ANY_CODE_IS_ABSENCE.test(line))
      .map(([line, number]) => `${path.relative(root, file)}:${number} ${line.trim()}`));
  assert.deepEqual(offenders, [], 'compare the code with ENOENT; any other error must not read as absence');
});

test('the guard recognises the shape it exists for', () => {
  for (const line of ['if (err.code) return { ...DEFAULTS };', 'if (error.code) { return null; }']) {
    assert.match(line, ANY_CODE_IS_ABSENCE, line);
  }
  for (const line of ["if (err.code === 'ENOENT') return null;", "if (err.code !== 'ENOENT') throw err;"]) {
    assert.doesNotMatch(line, ANY_CODE_IS_ABSENCE, line);
  }
});
