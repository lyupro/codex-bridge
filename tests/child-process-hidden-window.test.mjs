/**
 * 2026-09-24: black console windows flashed across the operator's screen at the end of every delegated
 * run. The run worker is spawned detached, so on Windows it has no console of its own, and every console
 * program it starts without `windowsHide` gets a new visible window — `git()` in `runner/git-state.mjs`
 * took the before/after snapshots that way, one window per call. Every child process in `src/` and `cli/`
 * must therefore say `windowsHide: true` literally at the call site (directly, or through a binding the
 * scanner can follow); a spread of options it cannot see does not count.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  argumentsFrom,
  bindingsFrom,
  identifier,
  importsFrom,
  refersToApi,
  sourceFiles,
  tokensWithoutComments,
  unquote,
} from './child-process-scan.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function hidesWindow(expression, bindings, seen = new Set()) {
  if (expression.length === 1 && identifier(expression[0])) {
    const [name] = expression;
    if (seen.has(name)) return false;
    const next = new Set([...seen, name]);
    return (bindings.get(name) || []).some((value) => hidesWindow(value, bindings, next));
  }
  if (expression[0] === '(' && expression.at(-1) === ')') return hidesWindow(expression.slice(1, -1), bindings, seen);
  if (expression[0] !== '{' || expression.at(-1) !== '}') return false;
  return argumentsFrom(expression.slice(1, -1), 0).some((property) => {
    if (property[0] === '...') return hidesWindow(property.slice(1), bindings, seen);
    return unquote(property[0]) === 'windowsHide' && property[1] === ':'
      && property.length === 3 && property[2] === 'true';
  });
}

function visibleCalls(source) {
  const tokens = tokensWithoutComments(source);
  const { apis, namespaces } = importsFrom(tokens);
  const bindings = bindingsFrom(tokens);
  let count = 0;
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (tokens[index + 1] !== '(') continue;
    const member = tokens[index - 1] === '.' || tokens[index - 1] === '?.';
    const callee = member ? tokens.slice(index - 2, index + 1) : [tokens[index]];
    if (!refersToApi(callee, apis, namespaces, bindings)) continue;
    const args = argumentsFrom(tokens, index + 2);
    if (!args.slice(1).some((argument) => hidesWindow(argument, bindings))) count += 1;
  }
  return count;
}

function offenders(files) {
  return files.filter(({ source }) => visibleCalls(source) > 0).map(({ file }) => file).sort();
}

const sources = ['src', 'cli'].flatMap((directory) => sourceFiles(path.join(root, directory)))
  .map((file) => ({
    file: path.relative(root, file).replaceAll(path.sep, '/'),
    source: fs.readFileSync(file, 'utf8'),
  }));

test('every child process in src and cli hides its console window', () => {
  const found = offenders(sources);
  assert.deepEqual(found, [], `Child processes must pass windowsHide: true at the call site: ${found.join(', ')}`);
});

test('the guard rejects calls that could open a window', () => {
  for (const source of [
    "import { spawnSync } from 'node:child_process'; spawnSync('git', ['status']);",
    "import { spawnSync } from 'node:child_process'; spawnSync('git', ['status'], { encoding: 'utf8' });",
    "import { spawn } from 'node:child_process'; spawn('git', [], { windowsHide: false });",
    "import { spawn } from 'node:child_process'; const hide = true; spawn('git', [], { windowsHide: hide });",
    "import { spawn } from 'node:child_process'; function go(options) { spawn('git', [], { ...options }); }",
    "import { spawnSync } from 'node:child_process'; function probe(run = spawnSync) { run('claude', ['--version'], {}); }",
    "import * as cp from 'node:child_process'; cp.execFileSync('git', [], { cwd: '.' });",
  ]) {
    const file = 'src/home/lib/planted-window.mjs';
    assert.ok(offenders([...sources, { file, source }]).includes(file), source);
  }
});

test('the guard accepts a literal flag, a followed binding and a followed spread', () => {
  for (const source of [
    "import { spawnSync } from 'node:child_process'; spawnSync('git', ['status'], { encoding: 'utf8', windowsHide: true });",
    "import { spawn } from 'node:child_process'; const options = { windowsHide: true }; spawn('git', [], options);",
    "import { spawn } from 'node:child_process'; const base = { windowsHide: true }; spawn('git', [], { ...base, cwd: '.' });",
    "import { spawn } from 'node:child_process'; function go(rest) { spawn('git', [], { ...rest, windowsHide: true }); }",
    "// spawnSync('git') in a comment is not a call",
  ]) {
    const file = 'src/home/lib/planted-window.mjs';
    assert.ok(!offenders([{ file, source }]).includes(file), source);
  }
});
