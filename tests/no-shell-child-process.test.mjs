/**
 * DEP0190 during update on Node 24 (2026-09-07) made the package greet users with a security
 * warning. Child processes must omit shell or spell it literally false; exec/execSync always
 * use a shell. Like one-file-lock, scan source and plant regressions in scan input, not files.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROCESS_APIS = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork'];
const SHELL_APIS = ['exec', 'execSync'];
const identifier = (token) => /^[A-Za-z_$][\w$]*$/.test(token || '');
const unquote = (token) => /^["'`]/.test(token || '') ? token.slice(1, -1) : token;

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return entry.isFile() && /\.(?:[cm]?[jt]sx?)$/.test(entry.name) ? [file] : [];
  });
}

// Keep strings opaque while removing comments: text mentioning an API is not a call/import.
function tokensWithoutComments(source) {
  const tokens = source.match(/(["'`])(?:\\[\s\S]|(?!\1)[^\\])*?\1|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|[A-Za-z_$][\w$]*|\.\.\.|===|!==|==|!=|=>|\?\.|[^\s]/g) || [];
  return tokens.filter((token) => !token.startsWith('//') && !token.startsWith('/*'));
}

function expressionEnd(tokens, start) {
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (['(', '[', '{'].includes(token)) depth += 1;
    else if ([')', ']', '}'].includes(token)) {
      if (depth === 0) return index;
      depth -= 1;
    } else if (depth === 0 && [',', ';'].includes(token)) return index;
  }
  return tokens.length;
}

function argumentsFrom(tokens, start) {
  const args = [];
  while (start < tokens.length) {
    const end = expressionEnd(tokens, start);
    args.push(tokens.slice(start, end));
    if (tokens[end] !== ',') break;
    start = end + 1;
  }
  return args;
}

function bindingsFrom(tokens) {
  const bindings = new Map();
  for (let index = 0; index < tokens.length - 2; index += 1) {
    if (!identifier(tokens[index]) || tokens[index + 1] !== '=' || tokens[index - 1] === '.') continue;
    const value = tokens.slice(index + 2, expressionEnd(tokens, index + 2));
    const values = bindings.get(tokens[index]) || [];
    values.push(value);
    bindings.set(tokens[index], values);
  }
  return bindings;
}

function importsFrom(tokens) {
  const apis = new Set(PROCESS_APIS);
  const namespaces = new Set();
  let forbidden = false;
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] !== 'import' || tokens[index + 1] === '(') continue;
    let end = index + 1;
    while (end < tokens.length && !['from', ';'].includes(tokens[end])) end += 1;
    if (!['node:child_process', 'child_process'].includes(unquote(tokens[end + 1]))) continue;
    if (identifier(tokens[index + 1])) namespaces.add(tokens[index + 1]);
    for (let at = index + 1; at < end; at += 1) {
      if (tokens[at] === '*' && tokens[at + 1] === 'as') namespaces.add(tokens[at + 2]);
      if (tokens[at - 1] !== '{' && tokens[at - 1] !== ',') continue;
      const imported = unquote(tokens[at]);
      if (SHELL_APIS.includes(imported)) forbidden = true;
      if (PROCESS_APIS.includes(imported)) {
        apis.add(tokens[at + 1] === 'as' ? tokens[at + 2] : imported);
      }
    }
  }
  return { apis, namespaces, forbidden };
}

function refersToApi(expression, apis, namespaces, bindings, seen = new Set()) {
  if (expression.length === 3 && namespaces.has(expression[0]) && expression[1] === '.') {
    return PROCESS_APIS.includes(expression[2]);
  }
  if (expression.length !== 1 || !identifier(expression[0])) return false;
  const [name] = expression;
  if (apis.has(name)) return true;
  if (seen.has(name)) return false;
  const next = new Set([...seen, name]);
  return (bindings.get(name) || []).some((value) => refersToApi(value, apis, namespaces, bindings, next));
}

function unsafeOptions(expression, bindings, seen = new Set()) {
  if (expression.length === 1 && identifier(expression[0])) {
    const [name] = expression;
    if (seen.has(name)) return false;
    const next = new Set([...seen, name]);
    return (bindings.get(name) || []).some((value) => unsafeOptions(value, bindings, next));
  }
  if (expression[0] === '(' && expression.at(-1) === ')') {
    return unsafeOptions(expression.slice(1, -1), bindings, seen);
  }
  if (expression[0] !== '{' || expression.at(-1) !== '}') return false;
  return argumentsFrom(expression.slice(1, -1), 0).some((property) => {
    if (property[0] === '...') return unsafeOptions(property.slice(1), bindings, seen);
    const computed = property[0] === '[' && property[2] === ']';
    const key = unquote(property[computed ? 1 : 0]);
    if (key !== 'shell') return false;
    const colon = computed ? 3 : 1;
    const value = property.slice(colon + 1);
    // Even a variable initialized to false violates the literal-only contract at the call site.
    return property[colon] !== ':' || value.length !== 1 || value[0] !== 'false';
  });
}

function usesShell(source) {
  const tokens = tokensWithoutComments(source);
  const { apis, namespaces, forbidden } = importsFrom(tokens);
  if (forbidden) return true;
  const bindings = bindingsFrom(tokens);
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (tokens[index + 1] !== '(') continue;
    const member = tokens[index - 1] === '.' || tokens[index - 1] === '?.';
    if (member && namespaces.has(tokens[index - 2]) && SHELL_APIS.includes(tokens[index])) return true;
    const callee = member ? tokens.slice(index - 2, index + 1) : [tokens[index]];
    if (!refersToApi(callee, apis, namespaces, bindings)) continue;
    const args = argumentsFrom(tokens, index + 2);
    // Options are second or third, depending on whether the optional argv array is supplied.
    if (args.slice(1).some((argument) => unsafeOptions(argument, bindings))) return true;
  }
  return false;
}

function offenders(files) {
  return files.filter(({ source }) => usesShell(source)).map(({ file }) => file).sort();
}

function assertNoShell(files) {
  const found = offenders(files);
  assert.deepEqual(found, [], `Child processes must omit shell or use literal false, and never import exec/execSync: ${found.join(', ')}`);
}

const sources = ['src', 'cli'].flatMap((directory) => sourceFiles(path.join(root, directory)))
  .map((file) => ({
    file: path.relative(root, file).replaceAll(path.sep, '/'),
    source: fs.readFileSync(file, 'utf8'),
  }));

test('src and cli never enable child-process shells or import exec/execSync', () => {
  for (const directory of ['src', 'cli']) assert.ok(sources.some(({ file }) => file.startsWith(`${directory}/`)));
  assertNoShell(sources);
});

test('the guard rejects shell plants in either scanned directory', () => {
  const violations = [
    "spawn('codex', [], { shell: true });",
    "spawnSync('codex', [], { shell: process.platform === 'win32' });",
    "const useShell = true; spawnSync('codex', [], { shell: useShell });",
    "const useShell = false; spawnSync('codex', [], { shell: useShell });",
    "spawn('codex', [], { shell: 'false' });",
    "const shell = true; spawn('codex', [], { shell });",
    "execFile('codex', { 'shell': true }, callback);",
    "execFileSync('codex', [], { ['shell']: true });",
    "fork('child.mjs', { shell: true });",
    "const options = { shell: true }; spawn('codex', [], options);",
    "const options = {\n shell: true,\n encoding: 'utf8'\n}; const alias = options; spawnSync('codex', ['--version'], alias);",
    "const useShell = true; const base = { shell: useShell }; const options = { ...base }; spawn('codex', [], options);",
    "import { spawn as launch } from 'node:child_process'; launch('codex', [], { shell: true });",
    "import { spawnSync } from 'node:child_process'; const run = spawnSync; run('codex', [], { shell: true });",
    "function probe(run = spawnSync) { run('codex', [], { shell: true }); }",
    "import * as cp from 'node:child_process'; cp.spawn('codex', [], { shell: true });",
    "import cp from 'node:child_process'; cp.exec('codex --version');",
    "import { execSync } from 'node:child_process';",
    "import { exec as run } from 'node:child_process';",
    "import { spawn, execSync as run } from 'node:child_process';",
    "import { exec } from 'child_process';",
  ];
  for (const directory of ['src/home/lib', 'cli']) {
    for (const source of violations) {
      const file = `${directory}/planted-shell.mjs`;
      const planted = [...sources, { file, source }];
      assert.ok(offenders(planted).includes(file), source);
      assert.throws(() => assertNoShell(planted), { code: 'ERR_ASSERTION' }, source);
    }
  }
});

test('the guard permits literal false, default options, regexes, strings and comments', () => {
  for (const source of [
    "spawn('codex', [], { shell: false });",
    "spawnSync('codex', ['--version'], { encoding: 'utf8' });",
    "execFile('codex', callback); fork('child.mjs');",
    "const options = { shell: false }; const alias = options; spawn('codex', [], alias);",
    "const base = { shell: false }; spawn('codex', [], { ...base });",
    "spawn('codex', [], { shell: /* intentional */ false });",
    "import { spawn as run } from 'node:child_process'; run('codex', [], { shell: false });",
    "import * as cp from 'node:child_process'; cp.spawn('codex', [], { shell: false });",
    '/x/.exec(value);',
    "const command = 'codex exec';",
    "const example = \"spawn('codex', [], { shell: true });\";",
    'const example = "import { execSync } from \'node:child_process\';";',
    "// spawn('codex', [], { shell: true });\nspawn('codex');",
    "/* import { execSync } from 'node:child_process'; */ spawn('codex');",
    "/* spawn('codex', [], { shell: true }); */ spawn('codex');",
    "const unrelated = { shell: true }; spawn('codex', [], { env: unrelated });",
    "import { exec } from './parser.mjs'; exec(value);",
  ]) {
    assert.deepEqual(offenders([{ file: 'cli/example.mjs', source }]), [], source);
  }
});
