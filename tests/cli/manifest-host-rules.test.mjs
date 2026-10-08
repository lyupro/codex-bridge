/** Guards the host rules install mapping in Plan_64 D5 and D9. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import { resolveHost } from '../../cli/hosts.mjs';
import { buildInstallPlan, rulesPlan } from '../../cli/manifest.mjs';

async function fixture(t) {
  const root = makeTempTree('bridge-manifest-host-rules-');
  t.after(() => removeTempTree(root));
  const packageRoot = path.join(root, 'package');
  const host = resolveHost({
    host: path.join(root, 'host'),
    codexHome: path.join(root, 'codex-home'),
    brandRoot: path.join(root, 'brand'),
  });
  for (const [relative, content] of [
    ['src/claude/agents/build.md', 'agent'],
    ['src/claude/commands/env.md', 'command'],
    ['src/home/lib/runtime.mjs', 'runtime'],
    ['package.json', '{"version":"9.9.9"}\n'],
  ]) {
    const source = path.join(packageRoot, relative);
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, content);
  }
  return { packageRoot, host };
}

test('host Markdown rules use the package subfolder and copy processing', async (t) => {
  const { packageRoot, host } = await fixture(t);
  const baseline = await buildInstallPlan(host, packageRoot);
  const source = path.join(packageRoot, 'src', 'claude', 'rules', 'core.md');
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, '# Core\r\n{{CODEX_BRIDGE_DIR}}\r\n');

  const plan = await buildInstallPlan(host, packageRoot);
  const items = plan.filter((item) => item.source === source);
  assert.deepEqual(items, [{
    source,
    target: path.join(host.root, 'rules', 'codex-bridge', 'core.md'),
    root: 'claude',
    relativeToRoot: 'rules/codex-bridge/core.md',
    relativeToHost: 'rules/codex-bridge/core.md',
    processing: 'copy',
    installationRoot: host.root,
  }]);
  assert.deepEqual(plan.filter((item) => item.source !== source), baseline);
});

test('an absent host rules folder leaves all existing install mappings unchanged', async (t) => {
  const { packageRoot, host } = await fixture(t);
  await assert.rejects(fs.stat(path.join(packageRoot, 'src', 'claude', 'rules')), { code: 'ENOENT' });
  const plan = await buildInstallPlan(host, packageRoot);
  assert.deepEqual(plan.map(({ root, relativeToRoot, processing }) => ({ root, relativeToRoot, processing })), [
    { root: 'brand', relativeToRoot: 'lib/runtime.mjs', processing: 'copy' },
    { root: 'brand', relativeToRoot: 'package.json', processing: 'copy' },
    { root: 'claude', relativeToRoot: 'agents/codex-bridge/build.md', processing: 'placeholders' },
    { root: 'claude', relativeToRoot: 'commands/codex-bridge/env.md', processing: 'placeholders' },
  ]);
});

test('non-Markdown host rules are not planned', async (t) => {
  const { packageRoot, host } = await fixture(t);
  const baseline = await buildInstallPlan(host, packageRoot);
  const source = path.join(packageRoot, 'src', 'claude', 'rules', 'notes.txt');
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, 'notes');
  assert.deepEqual(await buildInstallPlan(host, packageRoot), baseline);
});

test('Codex exec policy remains separate from the host install plan', async (t) => {
  const { packageRoot, host } = await fixture(t);
  const baseline = await buildInstallPlan(host, packageRoot);
  const source = path.join(packageRoot, 'src', 'codex', 'rules', 'codex-bridge.rules');
  await fs.mkdir(path.dirname(source), { recursive: true });
  await fs.writeFile(source, 'exec policy');
  const hostSource = path.join(packageRoot, 'src', 'claude', 'rules', 'core.md');
  await fs.mkdir(path.dirname(hostSource), { recursive: true });
  await fs.writeFile(hostSource, '# Core\n');

  const plan = await buildInstallPlan(host, packageRoot);
  assert.ok(plan.some((item) => item.source === hostSource));
  assert.ok(plan.every((item) => item.source !== source));
  assert.deepEqual(plan.filter((item) => item.source !== hostSource), baseline);
  assert.deepEqual(rulesPlan(host, packageRoot), {
    source,
    target: path.join(host.codexRulesDir, 'codex-bridge.rules'),
    name: 'codex-bridge.rules',
  });
});
