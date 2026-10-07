/** Guards structural family parsing and the no-evidence rule in Plan_67 D5. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { compareModelFamilies, modelFamily, NON_FAMILY_ALIASES } from '../src/home/lib/model-family.mjs';

test('all supported id shapes identify the first ASCII letter token after claude', () => {
  for (const id of [
    'claude-haiku-4-5-20251001',
    'claude-3-5-haiku-20241022',
    'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    'claude-haiku-4-5@20251001',
    'CLAUDE-3-5-HAIKU-20241022',
    'claude-3-haiku-sonnet-20251001',
    'haiku.claude.3.haiku@20251001',
  ]) assert.equal(modelFamily(id), 'haiku', id);
  assert.equal(modelFamily('claude-42-futurefamily-99'), 'futurefamily');
});

test('letter-only pin aliases are lowercase families without an id allowlist', () => {
  for (const family of ['haiku', 'sonnet', 'opus', 'FutureFamily']) {
    assert.equal(modelFamily(family), family.toLowerCase());
  }
});

test('a trailing context suffix is removed from aliases and ids', () => {
  assert.equal(modelFamily('sonnet[1m]'), 'sonnet');
  assert.equal(modelFamily('SONNET[1m]'), 'sonnet');
  assert.equal(modelFamily('claude-haiku[1m]'), 'haiku');
  assert.equal(modelFamily('claude-3-5-haiku-20241022[1m]'), 'haiku');
  assert.equal(modelFamily('sonnet[1m]extra'), null);
});

test('host non-family aliases live in one frozen list and never become pin families', () => {
  assert.deepEqual(NON_FAMILY_ALIASES, ['inherit', 'default', 'opusplan']);
  assert.ok(Object.isFrozen(NON_FAMILY_ALIASES));
  for (const alias of NON_FAMILY_ALIASES) {
    assert.equal(modelFamily(alias), null);
    assert.equal(modelFamily(alias.toUpperCase()), null);
    assert.equal(modelFamily(`${alias}[1m]`), null);
  }
});

test('synthetic, malformed, non-string and proxy ids provide no family evidence', () => {
  for (const value of [
    '<synthetic>', '', ' ', null, undefined, 42, {}, [], true,
    'proxy2', 'proxy-2-haiku', 'my.sonnet.proxy', 'notclaude-haiku-4',
    'claude', 'claude-3-5', 'claude-haiku4-5', 'claude-háiku-4',
    'K', ' haiku', 'haiku ', 'haiku\n', 'claude-haiku\n',
  ]) assert.equal(modelFamily(value), null, String(value));
});

test('match deduplicates parsed families and ignores mixed unparsed ids', () => {
  assert.deepEqual(compareModelFamilies({
    pinFamily: 'haiku',
    modelIds: ['claude-haiku-4-5-20251001', '<synthetic>', 'haiku', 'proxy2', 'HAIKU'],
  }), { verdict: 'match', parsed: ['haiku'], unparsed: 2 });
});

test('one differing parsed family is a violation regardless of unparsed ids or ordering', () => {
  for (const modelIds of [
    ['<synthetic>', 'haiku', 'sonnet', 'sonnet', 'proxy2'],
    ['sonnet', 'sonnet', 'proxy2', 'haiku', '<synthetic>'],
  ]) {
    const result = compareModelFamilies({ pinFamily: 'haiku', modelIds });
    assert.equal(result.verdict, 'violation');
    assert.deepEqual(new Set(result.parsed), new Set(['haiku', 'sonnet']));
    assert.equal(result.unparsed, 2);
  }
});

test('no pin or no parsed families is undetermined while preserving the evidence counts', () => {
  assert.deepEqual(compareModelFamilies({ pinFamily: null, modelIds: ['haiku', 'sonnet', '<synthetic>'] }), {
    verdict: 'undetermined', parsed: ['haiku', 'sonnet'], unparsed: 1,
  });
  assert.deepEqual(compareModelFamilies({ pinFamily: 'haiku', modelIds: ['<synthetic>', 'proxy2', 'inherit'] }), {
    verdict: 'undetermined', parsed: [], unparsed: 3,
  });
  assert.deepEqual(compareModelFamilies({ pinFamily: 'haiku', modelIds: [] }), {
    verdict: 'undetermined', parsed: [], unparsed: 0,
  });
  assert.deepEqual(compareModelFamilies({ pinFamily: null, modelIds: [] }), {
    verdict: 'undetermined', parsed: [], unparsed: 0,
  });
});
