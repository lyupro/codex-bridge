/**
 * Which worker a run was ordered with, and where each half of that answer came from.
 *
 * The provenance is the point. A configured profile reached no run for three releases and nothing
 * said so — the depth served by the fallback looked exactly like a depth the operator had chosen,
 * and a missing model looked like no model having been configured at all (2026-08-26).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runProfile } from '../../src/home/lib/runner/codex-args.mjs';

const build = (extra) => runProfile({ agent: 'codex-build', ...extra });

test('an explicit request wins over the configured depth and says so', () => {
  const profile = build({ effort: 'low', models: { build: { model: 'pinned', effort: 'max' } } });
  assert.equal(profile.effort, 'low');
  assert.equal(profile.effort_source, 'request');
  assert.equal(profile.model, 'pinned');
  assert.equal(profile.model_source, 'config');
});

test('the configured profile is used when the request names no depth', () => {
  const profile = build({ models: { build: { model: 'pinned', effort: 'max' } } });
  assert.equal(profile.effort, 'max');
  assert.equal(profile.effort_source, 'config');
});

test('an unconfigured mode falls back, and names the fallback as such', () => {
  const profile = build({ models: {} });
  assert.equal(profile.effort, 'medium');
  assert.equal(profile.effort_source, 'fallback');
  // Empty, because no `-m` is passed at all: Codex picks. The source says that out loud rather
  // than leaving an empty string to be read as "something went wrong".
  assert.equal(profile.model, '');
  assert.equal(profile.model_source, 'codex default');
});

test('a model pinned without a depth still reports the fallback depth honestly', () => {
  // The pair matters: pinning a model alone used to leave every run at the fallback depth, and
  // nothing distinguished that from a mode deliberately configured for it.
  const profile = build({ models: { build: { model: 'pinned' } } });
  assert.equal(profile.model_source, 'config');
  assert.equal(profile.effort, 'medium');
  assert.equal(profile.effort_source, 'fallback');
});

test('each mode reads its own profile', () => {
  const models = { scout: { model: 'scout-model' }, build: { model: 'build-model' } };
  assert.equal(runProfile({ agent: 'codex-scout', models }).model, 'scout-model');
  assert.equal(runProfile({ agent: 'codex-review', models }).model, '');
});
