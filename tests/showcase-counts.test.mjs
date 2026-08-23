/**
 * Holds the numbers the package advertises to the registry against the code that produces them.
 *
 * Three releases in a row shipped a wrong one: package.json said "5 guards, 604 tests" while the
 * registry had six hooks and 751 tests, README said 705, and CLAUDE.md said "five guard hooks".
 * Each was found by eye, twice during a release checklist and once not at all. A count written in
 * prose has no reader that fails, so this file becomes that reader.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_DEFINITIONS } from '../src/home/lib/hook-definitions.mjs';
import { claimedCounts, suiteCountMismatch } from '../scripts/suite-count.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const WORDS = new Map([
  ['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5], ['six', 6],
  ['seven', 7], ['eight', 8], ['nine', 9], ['ten', 10], ['eleven', 11], ['twelve', 12],
]);
// "6 guards", "six host guards", "six guard hooks" — every spelling the shipped text has used.
const GUARD_CLAIM = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:host\s+)?guards?\b/gi;

function guardClaims(text) {
  const claims = [];
  for (const [, quantity] of text.matchAll(GUARD_CLAIM)) {
    const numeric = WORDS.get(quantity.toLowerCase()) ?? Number(quantity);
    if (Number.isFinite(numeric)) claims.push(numeric);
  }
  return claims;
}

const SHOWCASE_FILES = ['README.md', 'CLAUDE.md'];

test('every advertised guard count matches the hook registry', () => {
  const expected = HOOK_DEFINITIONS.length;
  for (const file of SHOWCASE_FILES) {
    const claims = guardClaims(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    for (const claim of claims) {
      assert.equal(claim, expected, `${file} advertises ${claim} guards, the registry has ${expected}`);
    }
  }
});

test('the package description states the guard count the registry has', () => {
  const { description } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const claims = guardClaims(description);
  assert.ok(claims.length > 0, 'package.json description no longer states a guard count');
  for (const claim of claims) assert.equal(claim, HOOK_DEFINITIONS.length);
});

test('the package description states the suite size README states', () => {
  const { description } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const readme = claimedCounts(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8'));
  assert.ok(readme, 'README no longer states the suite size');
  const advertised = description.match(/\b(\d+)\s+tests\b/);
  assert.ok(advertised, 'package.json description no longer states a test count');
  assert.equal(Number(advertised[1]), readme.tests);
});

// The runner-side half: what it decides from a TAP summary, without running a suite to get one.
const TAP = (tests, pass, skipped) => `# tests ${tests}\n# suites 0\n# pass ${pass}\n# fail 0\n# cancelled 0\n# skipped ${skipped}\n`;
const README = (tests, pass, skipped) =>
  `The current suite contains **${tests} automated tests: ${pass} passing and ${skipped} skipped**.\n`;

test('a matching claim passes and a stale one names both numbers', () => {
  assert.equal(suiteCountMismatch(README(751, 750, 1), TAP(751, 750, 1)), null);
  const message = suiteCountMismatch(README(705, 704, 1), TAP(751, 750, 1));
  assert.match(message, /says 705 tests/);
  assert.match(message, /this run had 751/);
});

test('deleting the sentence does not silence the gate', () => {
  const message = suiteCountMismatch('# codex-bridge\n\nNo numbers here.\n', TAP(751, 750, 1));
  assert.match(message, /README no longer states the suite size/);
  assert.match(message, /751 automated tests/);
});

test('a partial run reports nothing to compare and stays silent', () => {
  assert.equal(suiteCountMismatch(README(751, 750, 1), ''), null);
  assert.equal(suiteCountMismatch(README(751, 750, 1), 'nothing parseable'), null);
});
