/**
 * Plan_80 E12: seeded files are written once, so new policy defaults must ship with runtime code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('seeded config keys require an explicit plan decision to expand', () => {
  const config = JSON.parse(fs.readFileSync(new URL('../src/home/config.json', import.meta.url), 'utf8'));
  assert.deepEqual(
    Object.keys(config).sort(),
    ['hooks', 'plugins', 'retention'],
    'A new seeded key needs a plan decision because seeded files never reach installed hosts.',
  );
});
