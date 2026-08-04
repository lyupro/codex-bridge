/** Verifies ownership results used when uninstalling shared rules. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remainingRulesOwners } from '../../cli/rules-owners.mjs';

test('a missing registry is distinct from an empty owner list', () => {
  assert.equal(remainingRulesOwners(null, { root: String.raw`C:\Repos\Current` }), null);
});

test('a sole owner leaves no owners remaining', () => {
  const host = { root: String.raw`C:\Repos\Current` };
  assert.deepEqual(remainingRulesOwners({ version: 1, owners: ['c:/repos/current'] }, host), []);
});

test('other owners remain when the current path differs in case and slashes', () => {
  const host = { root: String.raw`C:\Repos\Current` };
  const otherOwners = ['c:/repos/other', 'd:/repos/shared'];
  assert.deepEqual(
    remainingRulesOwners({
      version: 1,
      owners: ['c:/repos/other', 'c:/repos/current', 'd:/repos/shared'],
    }, host),
    otherOwners,
  );
});
