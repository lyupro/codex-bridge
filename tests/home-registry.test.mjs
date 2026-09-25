/** Verifies the Plan_62 D22 home artifact allowlist and its declared side-file spellings. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import {
  classifyHomePath,
  HOME_ARTIFACTS,
  HOME_DIRECTORIES,
  homeArtifact,
} from '../src/home/lib/home-registry.mjs';

const SIDE_NAMES = ['lock', 'atomic-temporary', 'dot-temporary', 'copy-temporary', 'pid-temporary'];

function samples(entry) {
  if (entry.id === 'install-image') return ['image/hooks/guard.mjs'];
  if (Array.isArray(entry.primary)) return entry.primary;
  return [`${entry.primary.dir}/${'a'.repeat(32)}.json`];
}

function sidePath(primaryPath, side) {
  const directory = path.posix.dirname(primaryPath);
  const name = path.posix.basename(primaryPath);
  const uuid = randomUUID();
  let sideName;
  if (side === 'lock') sideName = `${name}.lock`;
  if (side === 'atomic-temporary') sideName = `${name}.${uuid}.tmp`;
  if (side === 'dot-temporary' || side === 'copy-temporary') sideName = `.${name}.${uuid}.tmp`;
  if (side === 'pid-temporary') sideName = `${name}.42.${uuid}.tmp`;
  return directory === '.' ? sideName : `${directory}/${sideName}`;
}

test('each artifact and declared side spelling classifies to its owner', () => {
  for (const entry of HOME_ARTIFACTS) {
    for (const primary of samples(entry)) {
      const imageMembers = entry.id === 'install-image' ? [primary] : undefined;
      assert.deepEqual(classifyHomePath(primary, { imageMembers }), { id: entry.id, role: 'primary' });

      for (const side of entry.sides) {
        const spelling = sidePath(primary, side);
        assert.deepEqual(
          classifyHomePath(spelling, { imageMembers }),
          { id: entry.id, role: side },
          `${entry.id} ${side}`,
        );
      }
      for (const side of SIDE_NAMES.filter((candidate) => (
        !entry.sides.includes(candidate)
        && !(['dot-temporary', 'copy-temporary'].includes(candidate)
          && entry.sides.some((declared) => ['dot-temporary', 'copy-temporary'].includes(declared)))
      ))) {
        assert.equal(classifyHomePath(sidePath(primary, side)), null, `${entry.id} must reject ${side}`);
      }
    }
  }
});

test('install image paths only classify when supplied by the caller', () => {
  const member = 'image/cli/runner.mjs';
  const imageMembers = [member];
  assert.equal(classifyHomePath(member), null);
  assert.deepEqual(classifyHomePath(member, { imageMembers }), { id: 'install-image', role: 'primary' });
  assert.deepEqual(
    classifyHomePath(sidePath(member, 'copy-temporary'), { imageMembers }),
    { id: 'install-image', role: 'copy-temporary' },
  );
});

test('dispatcher family and unsafe relative paths reject near misses', () => {
  const invalidDispatchers = [
    `${'a'.repeat(31)}.json`,
    `${'a'.repeat(33)}.json`,
    `${'A'.repeat(32)}.json`,
    'x.json',
  ];
  for (const name of invalidDispatchers) {
    assert.equal(classifyHomePath(`state/dispatchers/${name}`), null);
  }

  for (const invalid of [
    '',
    '..',
    'state/../config.json',
    './config.json',
    'state//config.json',
    '/tmp/config.json',
    path.win32.resolve('C:\\outside\\config.json'),
    'state\\config.json',
  ]) {
    assert.equal(classifyHomePath(invalid), null, invalid);
  }

  for (const uuid of [
    '00000000-0000-1000-8000-000000000000',
    'abcdefab-cdef-4abc-8abc-abcdefabcdef'.toUpperCase(),
  ]) {
    assert.equal(classifyHomePath(`.config.json.${uuid}.tmp`), null, uuid);
  }
});

test('registry metadata is complete and no declared paths overlap', () => {
  assert.deepEqual(HOME_DIRECTORIES, ['state', 'state/dispatchers', 'state/diagnostics']);
  assert.equal(Object.isFrozen(HOME_ARTIFACTS), true);
  assert.equal(Object.isFrozen(HOME_DIRECTORIES), true);
  const removalClasses = new Set(['install-owned', 'purge-only', 'protected']);
  const claims = new Map();

  for (const entry of HOME_ARTIFACTS) {
    assert.ok(removalClasses.has(entry.removal), entry.id);
    assert.match(entry.consequence, /^[^.!?]+[.!?]$/, entry.id);
    assert.equal(Object.isFrozen(entry), true);
    for (const primary of samples(entry)) {
      const paths = [primary, ...entry.sides.map((side) => sidePath(primary, side))];
      for (const relativePath of paths) {
        assert.equal(claims.has(relativePath), false, `duplicate path claim: ${relativePath}`);
        claims.set(relativePath, entry.id);
      }
    }
    assert.equal(homeArtifact(entry.id), entry);
  }

  assert.throws(() => homeArtifact('unknown-artifact'), /Unknown home artifact id/);
});
