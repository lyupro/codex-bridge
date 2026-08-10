/** Refuses to run the suite against any root on the machine the package really installs into. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { ISOLATED_ROOTS } from '../scripts/isolated-roots.mjs';

const HOW = 'run the suite with `npm test`, which gives it throwaway roots of its own';

/**
 * The real directory each variable would point at if the suite ran without isolation. Both are
 * proven: `~/.codex` collected a rules file on 2026-08-03, and `~/.lyupro/.codex-bridge` collected
 * a config, conventions and an obsolete-file fixture on 2026-08-11 — where the stray config then
 * blocked the seeded-file migration it was supposed to be testing.
 */
const REAL_ROOTS = {
  CODEX_HOME: path.join(os.homedir(), '.codex'),
  CODEX_BRIDGE_HOME: path.join(os.homedir(), '.lyupro', '.codex-bridge'),
};

test('every isolated root is declared with the real directory it stands in for', () => {
  // A root added to run-tests.mjs without an entry here would be isolated but unguarded, which is
  // how the second root went unnoticed for a whole release.
  assert.deepEqual([...ISOLATED_ROOTS].sort(), Object.keys(REAL_ROOTS).sort());
});

for (const name of ISOLATED_ROOTS) {
  test(`${name} points at a throwaway directory, not the operator's`, () => {
    const value = process.env[name];
    assert.ok(value, `${name} is not set: ${HOW}`);
    const real = path.resolve(REAL_ROOTS[name]);
    assert.notEqual(path.resolve(value), real, `${name} points at ${real}: ${HOW}`);
    // A fixture that forgets to name a root falls back to this variable. Anchoring it under the
    // temp directory keeps that fallback harmless instead of merely unlikely.
    const temporary = path.resolve(os.tmpdir());
    assert.ok(
      path.resolve(value).startsWith(temporary),
      `${name} is outside ${temporary}: ${HOW}`,
    );
  });
}
