/**
 * OW-073: shell cwd silently picked the target repository for months. The orchestrator
 * itself left its shell in foreign folders twice on 2026-10-26. Every launch path must
 * keep repository choice in resolveOrderRepository instead of inheriting shell state.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceFiles, tokensWithOffsetsWithoutComments } from './child-process-scan.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Each exception must name its file and exact matched text, without a line number, and why.
const allowlist = Object.freeze({});
const requiredFiles = [
  'src/home/lib/order-schema.mjs',
  'src/home/lib/task-header.mjs',
  'src/home/lib/dispatcher-call.mjs',
  'src/home/lib/dispatcher-command.mjs',
  'src/home/hooks/order-gate.mjs',
];
const sources = [
  ...sourceFiles(path.join(root, 'src/home/lib/runner')).filter((file) => file.endsWith('.mjs'))
    .map((file) => path.relative(root, file).replaceAll(path.sep, '/')),
  ...requiredFiles,
].map((file) => ({ file, source: fs.readFileSync(path.join(root, file), 'utf8') }));

function parameterRanges(tokens) {
  const stack = [];
  const ranges = [];
  const controls = new Set(['if', 'for', 'while', 'switch', 'catch', 'with']);
  for (let at = 0; at < tokens.length; at += 1) {
    if (tokens[at] === '(') stack.push(at);
    if (tokens[at] !== ')') continue;
    const start = stack.pop();
    if (start === undefined) continue;
    const previous = tokens[start - 1];
    const functionHead = (/^[A-Za-z_$][\w$]*$/.test(previous || '') && !controls.has(previous))
      || previous === ']' || (previous === '*' && tokens[start - 2] === 'function');
    if (tokens[at + 1] === '=>' || (tokens[at + 1] === '{' && functionHead)) {
      ranges.push([start, at]);
    }
  }
  return ranges;
}

function cwdHits(source) {
  const entries = tokensWithOffsetsWithoutComments(source);
  const tokens = entries.map(({ text }) => text);
  const parameters = parameterRanges(tokens);
  const hits = [];
  const patterns = [
    ['process', '.', 'cwd', '('],
    ['process', '.', 'env', '.', 'PWD'],
    ['input', '.', 'cwd'],
    ['toolInput', '.', 'cwd'],
  ];
  for (let at = 0; at < tokens.length; at += 1) {
    let length = patterns.find((pattern) => pattern.every((token, offset) => tokens[at + offset] === token))?.length;
    if (tokens[at] === 'cwd' && tokens[at + 1] === '='
      && ['(', '{', ',', ':'].includes(tokens[at - 1])
      && parameters.some(([start, end]) => at > start && at < end)) length = 2;
    if (!length) continue;
    const last = entries[at + length - 1];
    const text = source.slice(entries[at].index, last.index + last.text.length);
    hits.push(text);
  }
  return hits;
}

function offenders(files) {
  return files.flatMap(({ file, source }) => cwdHits(source).flatMap((text) => {
    const key = `${file}:${text}`;
    return Object.hasOwn(allowlist, key) ? [] : [key];
  })).sort();
}

test('order launch paths never choose their repository from shell or hook cwd', () => {
  assert.ok(sources.some(({ file }) => file.startsWith('src/home/lib/runner/')));
  assert.deepEqual(offenders(sources), [], 'OW-073: cwd-based repository selection must not return');
});

test('the guard reports planted cwd dependencies without changing source files', () => {
  for (const [source, expected] of [
    ['const repo = process.cwd();', ['process.cwd(']],
    ['function f({ cwd = process.cwd() } = {}) {}', ['cwd =', 'process.cwd(']],
    ['resolveProjectRunsDir(root, input.cwd)', ['input.cwd']],
    ['const repo = process.env.PWD;', ['process.env.PWD']],
    ['resolveProjectRunsDir(root, toolInput.cwd)', ['toolInput.cwd']],
    ['function f(cwd = root) {}', ['cwd =']],
    ['const f = (cwd = root) => cwd;', ['cwd =']],
    ['function f({ cwd = root } = {}) {}', ['cwd =']],
    ['const f = function* (cwd = root) {};', ['cwd =']],
    ["class Launch { ['run'](cwd = root) {} }", ['cwd =']],
    ['process /* ignored */ . cwd ( );', ['process /* ignored */ . cwd (']],
  ]) {
    assert.deepEqual(cwdHits(source), expected, source);
    assert.ok(offenders([{ file: 'src/home/lib/runner/planted.mjs', source }]).length, source);
  }
});

test('comments, string literals and ordinary cwd values do not count', () => {
  for (const source of [
    '// process.cwd()',
    '/* process.cwd(); input.cwd; cwd = root */',
    "'process.cwd()'",
    'const example = "input.cwd; process.env.PWD; cwd = root";',
    'const example = `process.cwd()`;',
    'const cwd = root; launch({ cwd });',
    'function f(cwd) { cwd = root; return cwd; }',
    'if (cwd = root) { launch(cwd); }',
  ]) assert.deepEqual(cwdHits(source), [], source);
});

test('task input and order gate import the single repository resolver', () => {
  for (const file of ['src/home/lib/runner/task-input.mjs', 'src/home/hooks/order-gate.mjs']) {
    const { source } = sources.find((entry) => entry.file === file);
    const tokens = tokensWithOffsetsWithoutComments(source).map(({ text }) => text).join(' ');
    assert.match(tokens,
      /\bimport\s+\{[^}]*\bresolveOrderRepository\b[^}]*\}\s+from\s+['"][^'"]*order-repository\.mjs['"]/,
      `${file} must import resolveOrderRepository from order-repository.mjs`);
  }
});
