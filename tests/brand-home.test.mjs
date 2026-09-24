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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBrandHome } from '../src/home/lib/brand-home.mjs';

test('brand home reports whether its root came from the environment or the default', () => {
  const homedir = path.join(os.tmpdir(), 'bridge-resolver-home');
  const fallback = resolveBrandHome({ homedir, env: {} });
  assert.deepEqual(fallback, {
    root: path.join(homedir, '.lyupro', '.codex-bridge'),
    source: 'default',
    stateDir: path.join(homedir, '.lyupro', '.codex-bridge', 'state'),
    configPath: path.join(homedir, '.lyupro', '.codex-bridge', 'config.json'),
    conventionsPath: path.join(homedir, '.lyupro', '.codex-bridge', 'conventions.md'),
  });

  const override = path.join(os.tmpdir(), 'bridge-resolver-override');
  const configured = resolveBrandHome({ homedir, env: { CODEX_BRIDGE_HOME: override } });
  assert.equal(configured.root, override);
  assert.equal(configured.source, 'CODEX_BRIDGE_HOME');
  assert.equal(configured.stateDir, path.join(override, 'state'));
  assert.equal(configured.configPath, path.join(override, 'config.json'));
  assert.equal(configured.conventionsPath, path.join(override, 'conventions.md'));
});

function filesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(file) : entry.isFile() ? [file] : [];
  });
}

test('brand state paths are built only by brand-home.mjs', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const statePath = /path\.join\s*\([^)]*(?:\broot\b|\bBRAND_HOME\b)[^)]*,\s*(['"])state\1\s*\)/;
  const offenders = ['src', 'cli'].flatMap((directory) => filesUnder(path.join(root, directory)))
    .filter((file) => path.relative(root, file).replaceAll(path.sep, '/') !== 'src/home/lib/brand-home.mjs')
    .filter((file) => statePath.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(root, file).replaceAll(path.sep, '/'));
  assert.deepEqual(offenders, [], `Only brand-home.mjs may join a brand root with 'state': ${offenders.join(', ')}`);
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
