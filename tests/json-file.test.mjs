/** Locks the shared BOM-tolerant reader and the source-level no-raw-JSON.parse boundary. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readJsonFile,
  readJsonFileSync,
  readJsonFileWithRaw,
} from '../src/home/lib/json-file.mjs';
import { readJson as readArtifactJson } from '../src/home/lib/meta/paths.mjs';
import { readRunConfig, DEFAULTS } from '../src/home/lib/run-config.mjs';
import { readJsonFile as readAttachedJson } from '../src/home/lib/runner/attach.mjs';
import { makeTempTree, removeTempTree } from './temp-tree.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stdinHookExpressions = Object.freeze({
  'src/home/hooks/order-gate.mjs': "JSON.parse(fs.readFileSync(0, 'utf8'))",
  'src/home/hooks/prune-guard.mjs': "JSON.parse(fs.readFileSync(0, 'utf8'))",
  'src/home/hooks/reply-guard.mjs': "JSON.parse(fs.readFileSync(0, 'utf8'))",
  'src/home/hooks/stop-guard.mjs': "JSON.parse(fs.readFileSync(0, 'utf8'))",
  'src/home/hooks/worktree-lock.mjs': "JSON.parse(fs.readFileSync(0, 'utf8'))",
  // Not a hook file itself: it carries the source of the throwaway probe hook as a template, and
  // that hook reads its payload from stdin exactly like the five above. The rig it runs in has no
  // access to this package, so the shared reader cannot be imported there.
  'cli/probe-contract.mjs': "JSON.parse(fs.readFileSync(0, 'utf8'))",
});

async function fixture(t, content) {
  const directory = makeTempTree('bridge-json-file-');
  t.after(() => removeTempTree(directory));
  const file = path.join(directory, 'settings.json');
  await fs.writeFile(file, content);
  return file;
}

async function sourceFiles() {
  const patterns = ['src/**/*.mjs', 'cli/**/*.mjs', 'scripts/*.mjs'];
  const files = new Set();
  for (const pattern of patterns) {
    for await (const relative of fs.glob(pattern, { cwd: root })) {
      files.add(relative.replaceAll('\\', '/'));
    }
  }
  return [...files].sort();
}

test('shared JSON readers strip a leading BOM and expose raw text when requested', async (t) => {
  const file = await fixture(t, '\uFEFF{"answer":42}\n');
  assert.deepEqual(await readJsonFile(file), { answer: 42 });
  assert.deepEqual(readJsonFileSync(file), { answer: 42 });
  assert.deepEqual(await readJsonFileWithRaw(file), {
    raw: '\uFEFF{"answer":42}\n',
    value: { answer: 42 },
  });
});

test('shared JSON parse errors name the path and preserve the original cause', async (t) => {
  const file = await fixture(t, '{ broken');
  await assert.rejects(
    () => readJsonFile(file),
    (error) => error.message.startsWith('cannot parse ' + file + ': ')
      && error.cause instanceof SyntaxError,
  );
});

test('nullable and optional readers keep their missing-file contracts', async (t) => {
  const directory = makeTempTree('bridge-json-missing-');
  t.after(() => removeTempTree(directory));
  const missing = path.join(directory, 'missing.json');
  assert.equal(readArtifactJson(missing), null);
  assert.equal(readAttachedJson(missing), null);
  assert.deepEqual(readRunConfig(missing), DEFAULTS);
});

test('all source JSON parsing is centralized except explicit string and stdin inputs', async () => {
  const violations = [];
  for (const relative of await sourceFiles()) {
    let source = await fs.readFile(path.join(root, relative), 'utf8');
    const stdinExpression = stdinHookExpressions[relative];
    if (stdinExpression) {
      assert.equal(
        source.split(stdinExpression).length - 1,
        1,
        relative + ' must keep exactly one explicit stdin JSON parse exemption',
      );
      source = source.replace(stdinExpression, '');
    }
    if (relative === 'src/home/lib/meta/events.mjs') source = source.replaceAll('JSON.parse(source)', '');
    if (relative === 'src/home/lib/json-file.mjs') source = source.replace('JSON.parse(text)', '');
    if (/\bJSON\.parse\s*\(/.test(source)) violations.push(relative);
  }
  assert.deepEqual(
    violations,
    [],
    'raw JSON.parse remains in source files: ' + violations.join(', '),
  );
});
