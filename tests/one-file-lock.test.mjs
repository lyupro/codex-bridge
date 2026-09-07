/**
 * Plan_56 D44: the cross-process lost-edit incident needs one shared lock definition.
 * A second implementation could silently omit the registry's 2026-08-11 Windows recovery.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCK = 'src/home/lib/file-lock.mjs';

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return entry.isFile() && /\.(?:[cm]?[jt]sx?)$/.test(entry.name) ? [file] : [];
  });
}

function withoutComments(source) {
  return source.replace(/(["'`])(?:\\[\s\S]|(?!\1)[^\\])*?\1|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g,
    (token) => token.startsWith('//') || token.startsWith('/*') ? ' ' : token);
}

function callArguments(source, start) {
  const args = [];
  let depth = 0, quote = null, from = start;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if ('"\'`'.includes(char)) { quote = char; continue; }
    if ('([{'.includes(char)) depth += 1;
    else if (char === ')' && depth === 0) {
      args.push(source.slice(from, index).trim());
      return args;
    } else if (')]}'.includes(char)) depth -= 1;
    else if (char === ',' && depth === 0) {
      args.push(source.slice(from, index).trim());
      from = index + 1;
    }
  }
  return args;
}

function isLockPath(expression, source, seen = new Set()) {
  if (/["'`][^"'`]*\.lock["'`]/.test(expression)
    || /\b\w*lock(?:Path|File)\b/i.test(expression)) return true;
  for (const [name] of expression.matchAll(/\b[A-Za-z_$][\w$]*\b/g)) {
    if (seen.has(name)) continue;
    seen.add(name);
    for (const [, value] of source.matchAll(new RegExp(`\\b${name}\\s*=\\s*([^;\\n]+)`, 'g'))) {
      if (isLockPath(value, source, seen)) return true;
    }
  }
  return false;
}

function opensLock(source) {
  const apis = ['open', 'openSync'];
  for (const [, alias] of source.matchAll(/\bopen(?:Sync)?\s+as\s+(\w+)/g)) apis.push(alias);
  for (const match of source.matchAll(new RegExp(`\\b(?:${apis.join('|')})\\s*\\(`, 'g'))) {
    const [target, flag] = callArguments(source, match.index + match[0].length);
    if (/^["'`]wx["'`]$/.test(flag) && isLockPath(target, source)) return true;
  }
  return false;
}

function offenders(files) {
  return files.filter(({ file, source }) => file !== LOCK && opensLock(withoutComments(source)))
    .map(({ file }) => file).sort();
}

function assertOneLock(files) {
  const found = offenders(files);
  assert.deepEqual(found, [], `File locks must use ${LOCK}. Offenders: ${found.join(', ')}`);
}

const sources = ['src', 'cli'].flatMap((directory) => sourceFiles(path.join(root, directory)))
  .map((file) => ({
    file: path.relative(root, file).replaceAll(path.sep, '/'),
    source: fs.readFileSync(file, 'utf8'),
  }));

test('only file-lock opens lock paths with the exclusive wx flag', () => {
  assert.ok(sources.some(({ file, source }) => file === LOCK && opensLock(withoutComments(source))),
    'The shared lock definition must exist');
  assertOneLock(sources);
});

test('the guard rejects planted lock definitions in either scanned directory', () => {
  // D44 follows the one-config-writer guard: plant in scan input so no live source file is changed.
  const violations = [
    "await fs.open('config.json.lock', 'wx');",
    'fs.openSync("/home/operator/config.json.lock", "wx");',
    "const target = `${file}.lock`; await fs.open(target, 'wx');",
    "const target = path.join(root, 'registry.lock'); await fs.open(target, 'wx');",
    "await fs.open(path.resolve(root, 'registry.lock'), 'wx');",
    "const target = file + '.lock'; const alias = target; openSync(alias, 'wx');",
    "import { open as acquire } from 'node:fs/promises'; acquire(lockPath, 'wx');",
    "import { openSync as acquire } from 'node:fs'; acquire('registry.lock', 'wx');",
    "async function duplicate(lockPath) { return fs.open(lockPath, 'wx'); }",
  ];
  for (const directory of ['src/home/lib', 'cli']) {
    for (const source of violations) {
      const file = `${directory}/planted-lock.mjs`;
      const planted = [...sources, { file, source }];
      assert.ok(offenders(planted).includes(file), source);
      assert.throws(() => assertOneLock(planted), { code: 'ERR_ASSERTION' }, source);
    }
  }
});

test('the guard permits readers, temporary writers, shared callers, and the designated lock', () => {
  for (const source of [
    "await fs.open('config.json.lock', 'r');",
    "fs.openSync(lockPath, 'w');",
    "await fs.open(temporary, 'wx');",
    "await fs.open('config.json.lock.tmp', 'wx');",
    "const target = `${file}.lock`; await withFileLock(target, action);",
    "withFileLock(`${file}.lock`, async () => { await fs.open(temporary, 'wx'); });",
    "// fs.open(lockPath, 'wx');\nexport const value = 1;",
    "/* fs.open('config.json.lock', 'wx'); */ fs.open(temporary, 'wx');",
  ]) {
    assert.deepEqual(offenders([{ file: 'cli/example.mjs', source }]), [], source);
  }
  assert.deepEqual(offenders([{ file: LOCK, source: "fs.open(lockPath, 'wx');" }]), []);
});
