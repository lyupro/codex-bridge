/** Verifies host rules uninstall stays inside the package folder (Plan_64 D5, D9). */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { resolveHost } from '../../cli/hosts.mjs';
import { install } from '../../cli/install.mjs';
import { PACKAGE_ROOT } from '../../cli/manifest.mjs';
import { uninstall } from '../../cli/uninstall.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

const CORE = 'Package host rules\n';

async function fixture(t) {
  const root = makeTempTree('bridge-uninstall-host-rules-');
  t.after(() => removeTempTree(root));
  const host = resolveHost({
    host: path.join(root, 'host'),
    brandRoot: path.join(root, 'brand'),
    homedir: path.join(root, 'home'),
    codexHome: path.join(root, 'codex'),
  });
  const packageRoot = path.join(root, 'package');
  await fs.cp(path.join(PACKAGE_ROOT, 'src'), path.join(packageRoot, 'src'), { recursive: true });
  await fs.copyFile(path.join(PACKAGE_ROOT, 'package.json'), path.join(packageRoot, 'package.json'));
  const source = path.join(packageRoot, 'src', 'claude', 'rules', 'core.md');
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, CORE);
  const installed = await install({ host, packageRoot });
  assert.equal(installed.exitCode, 0, installed.output);
  const target = path.join(host.rulesDir, 'core.md');
  assert.equal(await fs.readFile(target, 'utf8'), CORE);
  return { host, packageRoot, target, rulesParent: path.dirname(host.rulesDir) };
}

test('uninstall removes package host rules and its folder but keeps operator rules', async (t) => {
  const { host, packageRoot, target, rulesParent } = await fixture(t);
  const mine = path.join(rulesParent, 'mine.md');
  await fs.writeFile(mine, 'Operator rules\n');

  const result = await uninstall({ host, packageRoot });

  assert.equal(result.exitCode, 0, result.output);
  await assert.rejects(fs.access(target), { code: 'ENOENT' });
  await assert.rejects(fs.access(host.rulesDir), { code: 'ENOENT' });
  assert.equal((await fs.stat(rulesParent)).isDirectory(), true);
  assert.equal(await fs.readFile(mine, 'utf8'), 'Operator rules\n');
  assert.deepEqual(await fs.readdir(rulesParent), ['mine.md']);
});

// D5's package boundary protects the host rules parent even when no operator files keep it nonempty.
test('uninstall keeps the emptied host rules parent', async (t) => {
  const { host, packageRoot, target, rulesParent } = await fixture(t);

  const result = await uninstall({ host, packageRoot });

  assert.equal(result.exitCode, 0, result.output);
  await assert.rejects(fs.access(target), { code: 'ENOENT' });
  await assert.rejects(fs.access(host.rulesDir), { code: 'ENOENT' });
  assert.equal((await fs.stat(rulesParent)).isDirectory(), true);
  assert.deepEqual(await fs.readdir(rulesParent), []);
});

test('uninstall preserves and names an operator-edited host core rule', async (t) => {
  const { host, packageRoot, target, rulesParent } = await fixture(t);
  const edited = 'Operator-edited core rules\n';
  await fs.writeFile(target, edited);

  const result = await uninstall({ host, packageRoot });

  assert.equal(result.exitCode, 0, result.output);
  assert.equal(await fs.readFile(target, 'utf8'), edited);
  assert.equal((await fs.stat(host.rulesDir)).isDirectory(), true);
  assert.equal((await fs.stat(rulesParent)).isDirectory(), true);
  assert.match(result.output, /^Left rules\/codex-bridge\/core\.md \((?:changed|unknown)\)$/m);
});
