/**
 * Plan_56 step 3: a copied effort list admitted unsupported pairs and rejected live additions.
 * Only the catalogue can enumerate a model's depths; offline readers validate form alone.
 * As with the role terminology gate, scan package source and prove the guard can reject a plant.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const SCANNED = ['src', 'cli'];
// These are test-only tripwires, never an authority for which values a run may use.
const DEPTHS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const QUOTED = /(['"`])(?:\\[\s\S]|(?!\1)[\s\S])*\1/g;

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() && full.endsWith('.mjs') ? [full] : [];
  });
}

function repeatedDepths(values) {
  return new Set(values.filter((value) => DEPTHS.has(value))).size >= 2;
}

function flatLists(source) {
  const code = source.replace(/\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|(['"`])(?:\\[\s\S]|(?!\1)[\s\S])*\1/g,
    (token) => token.startsWith('//') || token.startsWith('/*') ? token.replace(/[^\r\n]/g, ' ') : token);
  const found = [];
  const record = (index) => found.push(code.slice(0, index).split('\n').length);
  // Arrays cover both ordinary lists and Set constructors, independently of the variable name.
  for (const match of code.matchAll(/\[[^\]]*\]/g)) {
    const values = [...match[0].matchAll(QUOTED)].map(([literal]) => literal.slice(1, -1));
    // Review confidence/severity schemas share words with depths but describe findings, not models.
    const reviewScale = /\b(?:confidence|severity)\s*:\s*\{[^{}]*\benum\s*:\s*$/.test(code.slice(0, match.index));
    if (reviewScale) continue;
    if (repeatedDepths(values)) record(match.index);
  }
  // A split string, regex enumeration, or object-key map is still a copied list.
  for (const match of code.matchAll(QUOTED)) {
    const words = match[0].slice(1, -1).split(/[\s,|/]+/);
    if (words.every((word) => DEPTHS.has(word)) && repeatedDepths(words)) record(match.index);
  }
  for (const match of code.matchAll(/\/(?:\\.|[^/\r\n])+\/[a-z]*/g)) {
    if (repeatedDepths(match[0].match(/[a-z]+/g) || [])) record(match.index);
  }
  for (const match of code.matchAll(/\{[^{}]*\}/g)) {
    const keys = [...match[0].matchAll(/(?:['"]([a-z]+)['"]|\b([a-z]+))\s*:/g)]
      .map((key) => key[1] ?? key[2]);
    if (keys.every((key) => DEPTHS.has(key)) && repeatedDepths(keys)) record(match.index);
  }
  return [...new Set(found)];
}

function offenders(files) {
  return files.flatMap(({ file, source }) => flatLists(source).map((line) => `${file}:${line}`));
}

function assertNoFlatLists(files) {
  const found = offenders(files);
  assert.deepEqual(found, [], `Reasoning depths must come from the live catalogue. Offenders: ${found.join(', ')}`);
}

test('no package source holds a hard-coded list of reasoning depths', () => {
  const files = SCANNED.flatMap((directory) => sourceFiles(path.join(root, directory)));
  assertNoFlatLists(files.map((file) => ({
    file: path.relative(root, file).replaceAll('\\', '/'), source: fs.readFileSync(file, 'utf8'),
  })));
});

test('the guard fails on planted lists regardless of their name or representation', () => {
  for (const source of [
    "export const ALLOWED_EFFORTS = Object.freeze(['none', 'low', 'medium', 'high', 'xhigh', 'max']);",
    "const choices = [\n 'low', /* old subset */ 'high'\n];",
    'const renamed = new Set(["high", "ultra"]);',
    "const choices = 'low medium high'.split(' ');",
    'const accepts = /^(low|medium|high)$/;',
    'const choices = { low: true, high: true };',
    "const choices = { 'low': 1, 'high': 2 };",
  ]) {
    assert.throws(() => assertNoFlatLists([{ file: 'cli/planted.mjs', source }]),
      /Reasoning depths must come from the live catalogue.*cli\/planted.mjs/, source);
  }
});

test('the scan allows live values, unrelated lists, scalar defaults and explanatory comments', () => {
  for (const source of [
    'const efforts = entry.supported_reasoning_levels.map(({ effort }) => effort);',
    "const visibility = ['list', 'hide', 'none'];",
    "const fallback = 'medium';",
    "const schema = { confidence: { type: 'string', enum: ['high', 'medium', 'low'] } };",
    "const schema = { severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] } };",
    'const findings = { critical: 0, high: 0, medium: 0, low: 0 };',
    "// const historical = ['low', 'high'];",
    "/* const historical = ['low', 'high']; */",
  ]) assertNoFlatLists([{ file: 'src/example.mjs', source }]);
});
