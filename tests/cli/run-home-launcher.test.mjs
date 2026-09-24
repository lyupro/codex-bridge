/** Verifies run launches the installed home image and keeps hook dispatch independent. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import { makeHomeImage } from '../home-image.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(ROOT, 'bin', 'codex-bridge.mjs');

function run(args, home) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, CODEX_BRIDGE_HOME: home },
  });
}

test('run loads the runner from the installed home image and returns its exit code', async (t) => {
  const home = await makeHomeImage(t);
  const runner = path.join(home, 'lib', 'run-codex.mjs');
  await fs.writeFile(runner, "export async function runCodexCommand(args) { console.log('HOME_RUNNER ' + args.join(' ')); return 7; }\n");
  const result = run(['run', '--x', 'y'], home);
  assert.equal(result.status, 7, result.stderr);
  assert.match(result.stdout, /HOME_RUNNER --x y/);
});

test('run reports a missing installation and hook home remains dispatchable', async (t) => {
  const empty = makeTempTree('empty-home-');
  t.after(() => removeTempTree(empty));
  const missing = run(['run', '--x'], empty);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, new RegExp(`codex-bridge run: codex-bridge is not installed in ${empty.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\. Run codex-bridge install\\.`));

  const home = await makeHomeImage(t);
  const hookHome = spawnSync(process.execPath, [BIN, 'hook', '--home'], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, CODEX_BRIDGE_HOME: home },
  });
  assert.equal(hookHome.status, 0, hookHome.stderr);
  assert.deepEqual(JSON.parse(hookHome.stdout), { protocol: 1, dispatch: 'home', homeRoot: home });
});
