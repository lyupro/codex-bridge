#!/usr/bin/env node
/**
 * Guards paths.mjs: the pure functions that make two spellings of a path meet.
 *   node --test agents/codex-bridge/meta/paths.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { globToRegExp, expandDeclared, line, readJson } from '../../src/meta/paths.mjs';

// --- line -------------------------------------------------------------------------

test('line never leaves a partial multi-digit number at the limit', () => {
  assert.equal(line('All 298 tests pass', 6), 'All...');
  assert.equal(line('123456789', 7), '...');
});

// The first fix dropped a trailing number whenever the limit happened to land inside the NEXT
// word, so `All 298 12345678 rest` lost the 298 that fitted whole. A number that survived the
// retreat to a space is finished text and must be left alone.
test('line keeps a whole number that fits before the word boundary', () => {
  assert.equal(line('All 298 12345678 rest', 15), 'All 298...');
  assert.equal(line('All 298 tests 4567890 x', 17), 'All 298 tests...');
});

test('line leaves text shorter than the limit unchanged', () => {
  assert.equal(line('All 298 tests pass', 80), 'All 298 tests pass');
});

test('line including its ellipsis never exceeds the limit', () => {
  const result = line('Alpha beta gamma delta', 13);
  assert.ok(result.length <= 13);
  assert.match(result, /\.\.\.$/);
});

test('line handles long words, no spaces, tiny limits, and empty values', () => {
  assert.equal(line('supercalifragilistic', 8), 'super...');
  assert.equal(line('abcdefghij', 7), 'abcd...');
  assert.equal(line('word', 2), 'wo');
  assert.equal(line('', 10), '');
  assert.equal(line(null, 10), '');
  assert.equal(line(undefined, 10), '');
});

// --- readJson ---------------------------------------------------------------------

test('a status.json saved with a byte-order mark still reads', () => {
  // Not a hypothetical: PowerShell's `Set-Content -Encoding utf8` writes one, and a status.json
  // that fails to parse reads as "no such run" — which quietly excuses that run from every
  // check that looks it up, the abandoned-branch refusal included.
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-json-')), 'status.json');
  fs.writeFileSync(file, `﻿${JSON.stringify({ state: 'abandoned' })}`);
  assert.deepEqual(readJson(file), { state: 'abandoned' });
});

test('unreadable or malformed JSON is still null, not a throw', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-json-'));
  fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json');
  assert.equal(readJson(path.join(dir, 'broken.json')), null);
  assert.equal(readJson(path.join(dir, 'absent.json')), null);
});

// --- globToRegExp -----------------------------------------------------------------

test('src/** covers a direct child and a nested descendant alike', () => {
  const re = globToRegExp('src/**');
  assert.equal(re.test('src/a.ts'), true);
  assert.equal(re.test('src/deep/b.ts'), true);
});

test('a single * does not cross a directory boundary', () => {
  const re = globToRegExp('src/*.ts');
  assert.equal(re.test('src/a.ts'), true);
  assert.equal(re.test('src/deep/a.ts'), false);
});

test('glob matching ignores case', () => {
  assert.equal(globToRegExp('SRC/**').test('src/a.ts'), true);
});

// --- expandDeclared: one changes[] entry, several files ------------------------------

test('a brace-folded entry names every file it folds', () => {
  // Run 2026-07-31_120340 wrote exactly this string, changed three real files, and failed:
  // no git path can ever equal it.
  assert.deepEqual(
    expandDeclared(
      'packages/agent-sdk/src/cost/{types,phase-cost-recorder,phase-cost-reader,tier1-capture}.ts',
    ),
    [
      'packages/agent-sdk/src/cost/types.ts',
      'packages/agent-sdk/src/cost/phase-cost-recorder.ts',
      'packages/agent-sdk/src/cost/phase-cost-reader.ts',
      'packages/agent-sdk/src/cost/tier1-capture.ts',
    ],
  );
});

test('an enumeration of globs stays two patterns, not two paths', () => {
  assert.deepEqual(
    expandDeclared('packages/agent-sdk/src/cost/*.test.ts; apps/orchestrator/src/executors/*.test.ts'),
    ['packages/agent-sdk/src/cost/*.test.ts', 'apps/orchestrator/src/executors/*.test.ts'],
  );
});

test('an enumeration of plain paths becomes three paths', () => {
  assert.deepEqual(expandDeclared('a.ts; b.ts; c.ts'), ['a.ts', 'b.ts', 'c.ts']);
});

test('an ordinary path comes back as itself', () => {
  assert.deepEqual(expandDeclared('packages/agent-sdk/src/cost/types.ts'), [
    'packages/agent-sdk/src/cost/types.ts',
  ]);
});

test('nothing declared expands to nothing', () => {
  assert.deepEqual(expandDeclared(''), []);
  assert.deepEqual(expandDeclared(undefined), []);
});
