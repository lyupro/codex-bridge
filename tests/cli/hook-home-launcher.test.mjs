/** Verifies hook dispatch uses only the installed home image. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const BIN = path.join(ROOT, 'bin', 'codex-bridge.mjs');

function run(args, home) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_BRIDGE_HOME: home },
  });
}

async function fixture(t) {
  const root = makeTempTree('bridge-hook-home-');
  t.after(() => removeTempTree(root));
  const lib = path.join(root, 'lib');
  const hooks = path.join(root, 'hooks');
  await fs.mkdir(lib, { recursive: true });
  await fs.mkdir(hooks, { recursive: true });
  await fs.copyFile(path.join(ROOT, 'src', 'home', 'lib', 'hook-entry.mjs'), path.join(lib, 'hook-entry.mjs'));
  await fs.writeFile(path.join(lib, 'hook-definitions.mjs'), `export const HOOK_DEFINITIONS = [
    { name: 'home-only', file: 'home-guard.mjs' },
    { name: 'refusal', file: 'refusal.mjs' },
  ];\n`);
  await fs.writeFile(path.join(hooks, 'home-guard.mjs'), "console.log('HOME_GUARD_RAN'); process.exit(0);\n");
  await fs.writeFile(path.join(hooks, 'refusal.mjs'), "console.error('GUARD_REFUSAL'); process.exit(2);\n");
  return root;
}

test('home-only guard runs from installed home and its exit 2 passes through', async (t) => {
  const root = await fixture(t);
  const success = run(['hook', 'home-only'], root);
  assert.equal(success.status, 0);
  assert.match(success.stdout, /HOME_GUARD_RAN/);

  const refusal = run(['hook', 'refusal'], root);
  assert.equal(refusal.status, 2);
  assert.match(refusal.stderr, /GUARD_REFUSAL/);
});

test('a package-only hook name fails without running package guard', async (t) => {
  const root = await fixture(t);
  const result = run(['hook', 'reply-guard'], root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /guard "reply-guard" did not run: unknown hook name/);
  assert.doesNotMatch(result.stdout, /HOME_GUARD_RAN/);
});

test('missing home has no package fallback and --home reports protocol for absent root', (t) => {
  const missing = path.join(makeTempTree('bridge-hook-absent-'), 'absent-home');
  t.after(() => removeTempTree(path.dirname(missing)));
  const result = run(['hook', 'home-only'], missing);
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`not installed in ${missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

  const info = run(['hook', '--home'], missing);
  assert.equal(info.status, 0);
  assert.deepEqual(JSON.parse(info.stdout), { protocol: 1, dispatch: 'home', homeRoot: path.resolve(missing) });
  assert.equal(run(['hook'], missing).status, 1);
});
