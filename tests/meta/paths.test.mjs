#!/usr/bin/env node
/**
 * Guards paths.mjs: the pure functions that make two spellings of a path meet.
 *   node --test agents/codex/meta/paths.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globToRegExp, expandDeclared } from '../../src/meta/paths.mjs';

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
