/** Guards that a temporary tree outlives no test file, whether or not the file asks for cleanup. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { makeTempTree, removeTempTree } from './temp-tree.mjs';

test('makeTempTree creates trees inside the suite temp root', () => {
  const root = process.env.CODEX_BRIDGE_TEST_TMP;
  assert.ok(root);
  const dir = makeTempTree('cleanup-root-');
  const relative = path.relative(root, dir);

  assert.notEqual(relative, '');
  assert.notEqual(relative, '..');
  assert.ok(!relative.startsWith(`..${path.sep}`));
  assert.ok(!path.isAbsolute(relative));
});

test('makeTempTree refuses to run outside npm test', () => {
  const previousRoot = process.env.CODEX_BRIDGE_TEST_TMP;
  delete process.env.CODEX_BRIDGE_TEST_TMP;

  try {
    assert.throws(
      () => makeTempTree('cleanup-missing-root-'),
      /suite was started outside npm test.*throwaway root/i,
    );
  } finally {
    if (previousRoot === undefined) delete process.env.CODEX_BRIDGE_TEST_TMP;
    else process.env.CODEX_BRIDGE_TEST_TMP = previousRoot;
  }
});

test('removeTempTree tolerates an already-removed tree', async () => {
  const dir = makeTempTree('cleanup-already-removed-');
  await removeTempTree(dir);

  await assert.doesNotReject(() => removeTempTree(dir));
});

// The point of the whole mechanism, and the only case that proves it: a test file that never says
// a word about cleanup still leaves nothing behind. It runs in a child process because the sweep
// happens when a file finishes, which this file cannot observe about itself.
test('a tree created without any cleanup line is gone once its file finishes', () => {
  const workspace = makeTempTree('cleanup-sweep-');
  const marker = path.join(workspace, 'created-tree.txt');
  const file = path.join(workspace, 'no-cleanup.test.mjs');
  const helper = new URL('./temp-tree.mjs', import.meta.url).href;
  fs.writeFileSync(
    file,
    [
      "import test from 'node:test';",
      "import fs from 'node:fs';",
      `import { makeTempTree } from ${JSON.stringify(helper)};`,
      "test('creates a tree and says nothing about removing it', () => {",
      `  fs.writeFileSync(${JSON.stringify(marker)}, makeTempTree('cleanup-swept-'));`,
      '});',
      '',
    ].join('\n'),
  );

  // NODE_TEST_CONTEXT is set for this process by the runner, and a child that inherits it reports
  // itself as a nested runner: it exits 0 without running a single test. Left in place, this guard
  // would pass while proving nothing, which is worse than not having it.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ['--test', file], { encoding: 'utf8', env });

  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /pass 1/, 'the child ran no test at all');
  const swept = fs.readFileSync(marker, 'utf8');
  assert.equal(fs.existsSync(swept), false, `${swept} outlived the file that created it`);
});
