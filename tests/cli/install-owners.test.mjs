/** Verifies format-2 ownership without filesystem access. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeRepoPath } from '../../src/home/lib/runner/project-dir.mjs';
import { isFormat2, ownerView, validateFormat2, withOwner, withoutOwner } from '../../cli/install-owners.mjs';

const brandFiles = [
  { root: 'brand', path: 'hooks/reply-guard.mjs' },
  { root: 'brand', path: 'lib/runner.mjs' },
];

function host(root, scope = 'project') {
  return { root, scope };
}

function record(label = 'alpha', overrides = {}) {
  const ownerPath = 'agents/' + label + '/reply-guard.mjs';
  return {
    name: '@lyupro/codex-bridge',
    version: '1.2.3',
    installedAt: '2026-09-27T17:00:00.000Z',
    mode: 'copy',
    files: [
      { root: 'claude', path: ownerPath },
      ...brandFiles,
    ],
    fingerprints: {
      claude: { [ownerPath]: 'a'.repeat(64) },
      brand: {
        'hooks/reply-guard.mjs': 'b'.repeat(64),
        'lib/runner.mjs': 'c'.repeat(64),
      },
    },
    hooks: [{
      event: 'SubagentStop',
      root: 'claude',
      path: ownerPath,
      command: 'codex-bridge hook reply-guard',
    }],
    ...overrides,
  };
}

test('new records mark inventory complete only when absence of an old image was confirmed', () => {
  const target = host('/repos/alpha/.claude');
  assert.equal(withOwner(null, target, record(), { homeHadImage: false }).inventory, 'complete');
  assert.equal(withOwner(null, target, record(), { homeHadImage: true }).inventory, 'incomplete');
  assert.equal(withOwner(null, target, record()).inventory, 'incomplete');
});

test('format-1 migration preserves the old record and registers only the migrating host', () => {
  const legacy = record('old');
  const migrated = withOwner(legacy, host('/repos/new/.claude'), record('new'));
  const key = normalizeRepoPath('/repos/new/.claude');
  assert.equal(migrated.inventory, 'incomplete');
  assert.deepEqual(migrated.legacy, legacy);
  assert.deepEqual(Object.keys(migrated.owners), [key]);
  assert.equal(migrated.owners[key].root, '/repos/new/.claude');
});

test('format 2 retains other owners and replaces only the writing host', () => {
  const firstHost = host('/repos/first/.claude', 'project');
  const secondHost = host('/repos/second/.claude', 'user');
  const firstRecord = record('first');
  const secondRecord = record('second', { version: '2.0.0' });
  const initial = withOwner(null, firstHost, firstRecord, { homeHadImage: false });
  const withSecond = withOwner(initial, secondHost, secondRecord);
  const firstKey = normalizeRepoPath(firstHost.root);
  const secondKey = normalizeRepoPath(secondHost.root);

  assert.deepEqual(withSecond.owners[firstKey], initial.owners[firstKey]);
  assert.deepEqual(ownerView(withSecond, firstHost).hooks, firstRecord.hooks);
  assert.deepEqual(ownerView(withSecond, firstHost).files.slice(2), firstRecord.files.filter((f) => f.root === 'claude'));
  assert.deepEqual(ownerView(withSecond, secondHost).hooks, secondRecord.hooks);
  assert.equal(withSecond.inventory, 'complete');

  const replacement = record('first-v2', { version: '3.0.0' });
  const rewritten = withOwner(withSecond, firstHost, replacement);
  assert.deepEqual(rewritten.owners[firstKey].hooks, replacement.hooks);
  assert.deepEqual(rewritten.owners[secondKey], withSecond.owners[secondKey]);
  assert.equal(ownerView(rewritten, host('/repos/not-owner/.claude')), null);
});

test('owner keys use normalized repository paths and Windows case variants share one owner', () => {
  const root = process.platform === 'win32'
    ? 'C:\\Repos\\Shared\\.claude'
    : '/repos/shared/.claude';
  const firstHost = host(root);
  const initial = withOwner(null, firstHost, record());
  const key = Object.keys(initial.owners)[0];

  if (process.platform === 'win32') {
    assert.equal(key, key.toLowerCase());
    assert.ok(key.includes('/'));
    assert.ok(!key.includes('\\'));
    const changedCase = root.toLowerCase();
    const second = withOwner(initial, host(changedCase), record('case-variant'));
    assert.deepEqual(Object.keys(second.owners), [key]);
  } else {
    assert.equal(key, normalizeRepoPath(root));
  }
});

test('withoutOwner removes exactly one owner and preserves shared record data', () => {
  const firstHost = host('/repos/first/.claude');
  const secondHost = host('/repos/second/.claude');
  const initial = withOwner(null, firstHost, record(), { homeHadImage: false });
  const shared = withOwner(initial, secondHost, record('second'));
  const withLegacy = { ...shared, legacy: record('legacy') };
  const next = withoutOwner(withLegacy, firstHost);
  const secondKey = normalizeRepoPath(secondHost.root);

  assert.deepEqual(Object.keys(next.owners), [secondKey]);
  assert.deepEqual(next.owners[secondKey], withLegacy.owners[secondKey]);
  assert.deepEqual(next.image, withLegacy.image);
  assert.equal(next.inventory, withLegacy.inventory);
  assert.deepEqual(next.legacy, withLegacy.legacy);
  assert.equal(next.name, withLegacy.name);
  assert.equal(next.mode, withLegacy.mode);
});

test('withoutOwner leaves an incomplete inventory with no owners valid', () => {
  const target = host('/repos/only/.claude');
  const initial = withOwner(null, target, record());
  const next = withoutOwner(initial, target);

  assert.deepEqual(next.owners, {});
  assert.equal(next.inventory, 'incomplete');
  assert.equal(validateFormat2(next), next);
});

test('format 2 rejects an empty owner set when inventory is complete', () => {
  const initial = withOwner(null, host('/repos/only/.claude'), record(), { homeHadImage: false });
  assert.throws(
    () => validateFormat2({ ...initial, owners: {} }),
    /no owners must have an incomplete inventory/,
  );
});

test('withoutOwner returns the original record when the host is not an owner', () => {
  const initial = withOwner(null, host('/repos/owner/.claude'), record());
  assert.strictEqual(withoutOwner(initial, host('/repos/not-owner/.claude')), initial);
});
test('format-2 validation rejects unknown formats, invalid inventory, and mismatched owner roots', () => {
  const valid = withOwner(null, host('/repos/alpha/.claude'), record());
  assert.equal(isFormat2(valid), true);
  assert.throws(() => validateFormat2({ ...valid, format: 3 }), /format must be 2/);
  assert.throws(() => validateFormat2({ ...valid, inventory: 'unknown' }), /inventory/);
  assert.throws(() => validateFormat2({ ...valid, owners: [] }), /owners must be an object/);

  const [validKey] = Object.keys(valid.owners);
  const badOwner = structuredClone(valid);
  badOwner.owners[validKey].hooks = [{ event: 'unknown', root: 'claude', path: 'agents/a/reply-guard.mjs' }];
  assert.throws(() => validateFormat2(badOwner), /supported event/);

  const badImage = structuredClone(valid);
  badImage.image.files[0].path = 'codex-runs/image.mjs';
  assert.throws(() => validateFormat2(badImage), /must not name run artifacts/);

  const mismatched = structuredClone(valid);
  const [key] = Object.keys(mismatched.owners);
  mismatched.owners[key].root = '/repos/other/.claude';
  assert.throws(() => validateFormat2(mismatched), /normalize to its key/);
});
