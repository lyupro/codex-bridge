/**
 * The one resolver of the host-side home: where it points, and whether it says so honestly.
 *
 * Both halves matter. The path, because a runtime that built it from its own module directory read
 * the package seed for three releases while the operator edited the home copy. The provenance,
 * because the same output has to distinguish an overridden home from the default one — an operator
 * looking at a printed path could not otherwise tell which of two files named config.json was read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { resolveBrandHome } from '../src/home/lib/brand-home.mjs';

test('brand home reports whether its root came from the environment or the default', () => {
  const homedir = path.join(os.tmpdir(), 'bridge-resolver-home');
  const fallback = resolveBrandHome({ homedir, env: {} });
  assert.deepEqual(fallback, {
    root: path.join(homedir, '.lyupro', '.codex-bridge'),
    source: 'default',
    configPath: path.join(homedir, '.lyupro', '.codex-bridge', 'config.json'),
    conventionsPath: path.join(homedir, '.lyupro', '.codex-bridge', 'conventions.md'),
  });

  const override = path.join(os.tmpdir(), 'bridge-resolver-override');
  const configured = resolveBrandHome({ homedir, env: { CODEX_BRIDGE_HOME: override } });
  assert.equal(configured.root, override);
  assert.equal(configured.source, 'CODEX_BRIDGE_HOME');
  assert.equal(configured.configPath, path.join(override, 'config.json'));
  assert.equal(configured.conventionsPath, path.join(override, 'conventions.md'));
});

/**
 * The seeded conventions travel with the config: `runner/conventions.mjs` derives the host-wide
 * conventions.md from the same directory, so a resolver that got the config right and the
 * conventions wrong would move the defect one file sideways rather than fix it.
 */
test('the seeded files resolve inside the same home', () => {
  const home = path.join(os.tmpdir(), 'bridge-resolver-pair');
  const resolved = resolveBrandHome({ env: { CODEX_BRIDGE_HOME: home } });
  assert.equal(path.dirname(resolved.configPath), resolved.root);
  assert.equal(path.dirname(resolved.conventionsPath), resolved.root);
});
