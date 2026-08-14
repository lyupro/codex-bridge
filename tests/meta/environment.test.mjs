#!/usr/bin/env node
/**
 * Guards environment.mjs: which touched paths belong to the run and which to the tooling
 * writing alongside it.
 *   node --test agents/codex-bridge/meta/environment.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { environmentPatterns, splitEnvironment, splitRunChanges } from '../../src/home/lib/meta/environment.mjs';
import { makeRun } from './test-fixtures.mjs';

test('a run folder whose env.json predates the list has no environment at all', () => {
  const dir = makeRun({ before: '', after: 'U\t10\t.omc/project-memory.json\n' });
  assert.deepEqual(environmentPatterns(dir), []);
  // The pre-2026-08-02 behaviour, kept on purpose: with no recorded patterns every change
  // is the run's own, so an old run recomputed today gives the verdict it gave then.
  assert.deepEqual(splitRunChanges(dir, ['.omc/project-memory.json']), {
    work: ['.omc/project-memory.json'],
    environment: [],
  });
});

test('patterns come from the run own env.json, trimmed and without blanks', () => {
  const dir = makeRun({ envPaths: ['  .omc/**  ', '', '.claude/settings.local.json'] });
  assert.deepEqual(environmentPatterns(dir), ['.omc/**', '.claude/settings.local.json']);
});

test('the environment keeps its files and the run keeps its own', () => {
  const { work, environment } = splitEnvironment(
    ['src/a.ts', '.omc/project-memory.json', 'plugins/installed_plugins.json'],
    ['.omc/**', 'plugins/installed_plugins.json'],
  );
  assert.deepEqual(work, ['src/a.ts']);
  assert.deepEqual(environment, ['.omc/project-memory.json', 'plugins/installed_plugins.json']);
});

test('a backslash path from Codex meets a forward-slash pattern', () => {
  const backslashPath = ['.omc', 'state', 'run.json'].join(String.fromCharCode(92));
  const { work, environment } = splitEnvironment([backslashPath], ['.omc/**']);
  assert.deepEqual(work, []);
  assert.deepEqual(environment, ['.omc/state/run.json']);
});

test('an empty pattern list attributes everything to the run', () => {
  const { work, environment } = splitEnvironment(['.omc/x.json', 'src/a.ts'], []);
  assert.deepEqual(work, ['.omc/x.json', 'src/a.ts']);
  assert.deepEqual(environment, []);
});

test('a similar directory name does not match an environment glob', () => {
  const { work, environment } = splitEnvironment(
    ['.omcx/state.json', '.omc/state.json'],
    ['.omc/**'],
  );
  assert.deepEqual(work, ['.omcx/state.json']);
  assert.deepEqual(environment, ['.omc/state.json']);
});

test('each run uses the environment paths recorded in its own env.json', () => {
  const path = '.omc/project-memory.json';
  const runWithoutEnvironment = makeRun({ envPaths: [] });
  const runWithEnvironment = makeRun({ envPaths: ['.omc/**'] });

  assert.deepEqual(splitRunChanges(runWithoutEnvironment, [path]), {
    work: [path],
    environment: [],
  });
  assert.deepEqual(splitRunChanges(runWithEnvironment, [path]), {
    work: [],
    environment: [path],
  });
});
