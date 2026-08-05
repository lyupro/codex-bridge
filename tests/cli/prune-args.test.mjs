/** Verifies prune scope parsing, refusal rules, and older-than grammar. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOlderThan, parsePruneArgs } from '../../cli/prune-args.mjs';

test('accepts duration and exact-date older-than forms', () => {
  assert.deepEqual(parseOlderThan('30d'), { kind: 'duration', amount: 30, unit: 'd' });
  assert.deepEqual(parseOlderThan('12h'), { kind: 'duration', amount: 12, unit: 'h' });
  assert.deepEqual(parseOlderThan('2026-07-01'), { kind: 'date', date: '2026-07-01' });
  assert.equal(parseOlderThan('2026-02-30').error.includes('YYYY-MM-DD'), true);
  assert.equal(parseOlderThan('0d').error.includes('positive duration'), true);
});

test('defaults age only for broad scopes and accepts both force spellings', () => {
  assert.deepEqual(parsePruneArgs(['alpha']).olderThan, {
    kind: 'duration', amount: 30, unit: 'd',
  });
  assert.equal(parsePruneArgs(['alpha', 'run']).olderThan, null);
  assert.deepEqual(parsePruneArgs(['--all-projects']).olderThan, {
    kind: 'duration', amount: 30, unit: 'd',
  });
  assert.equal(parsePruneArgs(['alpha', 'run', '-f']).force, true);
  assert.equal(parsePruneArgs(['alpha', 'run', '--force']).force, true);
});

test('supports equals syntax for older-than and refuses all-projects purge', () => {
  const parsed = parsePruneArgs(['--all-projects', '--older-than=12h', '--json']);
  assert.deepEqual(parsed.olderThan, { kind: 'duration', amount: 12, unit: 'h' });
  assert.equal(parsed.json, true);

  const refused = parsePruneArgs(['--all-projects', '--purge']);
  assert.match(refused.error, /cannot be combined with --purge/);
});

test('refuses malformed scopes, names, and unknown options', () => {
  assert.match(parsePruneArgs([]).error, /expected/);
  assert.match(parsePruneArgs(['alpha', 'one', 'two']).error, /expected/);
  assert.match(parsePruneArgs(['alpha', '../outside']).error, /bare folder name/);
  assert.match(parsePruneArgs(['alpha', '--yes']).error, /unknown option/);
  assert.match(parsePruneArgs(['alpha', '--older-than']).error, /requires a value/);
});
