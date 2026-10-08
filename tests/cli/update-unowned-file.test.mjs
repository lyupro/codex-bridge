/** A file the package now plans but someone else already wrote stops update (Plan_64 B2c). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { install } from '../../cli/install.mjs';
import { update } from '../../cli/update.mjs';
import { fixture, packageFixture } from './update-fixtures.mjs';

const CORE = 'Package core rules\n';

async function hostWithNewRulesFile(t, existing) {
  const { root, host } = await fixture(t);
  // The real package ships a core since Plan_64 B7a; the old package must predate it for the path to be new.
  const oldPackage = await packageFixture(root, 'old-package', { omit: path.join('claude', 'rules') });
  assert.equal((await install({ host, packageRoot: oldPackage })).exitCode, 0);
  const newPackage = await packageFixture(root, 'new-package', { version: '0.0.1' });
  const source = path.join(newPackage, 'src', 'claude', 'rules', 'core.md');
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, CORE);
  const target = path.join(host.rulesDir, 'core.md');
  if (existing !== undefined) {
    await fs.mkdir(host.rulesDir, { recursive: true });
    await fs.writeFile(target, existing);
  }
  return { host, newPackage, target };
}

test('update stops on an unrecorded file in a newly planned path and leaves it as it was', async (t) => {
  const { host, newPackage, target } = await hostWithNewRulesFile(t, 'Operator rules\n');
  const result = await update({ host, packageRoot: newPackage });
  assert.equal(result.exitCode, 1, result.output);
  assert.match(result.output, /^ {2}claude\/rules\/codex-bridge\/core\.md \(unowned\)$/m);
  assert.equal(await fs.readFile(target, 'utf8'), 'Operator rules\n');
});

test('update --force overwrites the unowned file with the package bytes', async (t) => {
  const { host, newPackage, target } = await hostWithNewRulesFile(t, 'Operator rules\n');
  const result = await update({ host, packageRoot: newPackage, force: true });
  assert.equal(result.exitCode, 0, result.output);
  assert.equal(await fs.readFile(target, 'utf8'), CORE);
});

test('an unrecorded file that already holds the package bytes is adopted without --force', async (t) => {
  const { host, newPackage, target } = await hostWithNewRulesFile(t, CORE);
  const result = await update({ host, packageRoot: newPackage });
  assert.equal(result.exitCode, 0, result.output);
  assert.equal(await fs.readFile(target, 'utf8'), CORE);
});

test('a newly planned path that is empty is created as before', async (t) => {
  const { host, newPackage, target } = await hostWithNewRulesFile(t);
  const result = await update({ host, packageRoot: newPackage });
  assert.equal(result.exitCode, 0, result.output);
  assert.equal(await fs.readFile(target, 'utf8'), CORE);
});
