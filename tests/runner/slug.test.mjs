/** Regression coverage for Plan_29 slug derivation and legacy chain lookup. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import { chainRuns, taskFingerprint } from '../../src/home/lib/meta/chain.mjs';
import { makeRunDir, runDirPath } from '../../src/home/lib/runner/launcher.mjs';
import { makeChainRoot, CHAIN_REPO } from '../meta/test-fixtures.mjs';

const ARGS_MODULE = new URL('../../src/home/lib/runner/args.mjs', import.meta.url).href;
const RUN_STAMP = '2026-08-13_235525';

// raw argv: separator-only order ids must reach parseArgs unchanged for its exact refusal.
function reviewArgs(orderId, slug) {
  return [
    '--agent', 'codex-review',
    '--repo', CHAIN_REPO,
    ...(slug === undefined ? [] : ['--slug', slug]),
    '--order-id', orderId,
  ];
}

test('a leading slug date appears only once in the run directory name', () => {
  const runDir = runDirPath('/runs', '2026-08-13_plan4-6g-ceiling-scope', RUN_STAMP);
  assert.equal(path.basename(runDir), '2026-08-13_235525_plan4-6g-ceiling-scope');
  assert.equal(
    path.basename(runDirPath('/runs', '2026-08-13-plan4-6g-ceiling-scope', RUN_STAMP)),
    '2026-08-13_235525_plan4-6g-ceiling-scope',
  );
});

test('a slug without a date keeps the existing run directory name', () => {
  const runDir = runDirPath('/runs', 'plan4-6g-ceiling-scope', RUN_STAMP);
  assert.equal(path.basename(runDir), '2026-08-13_235525_plan4-6g-ceiling-scope');
});

test('a slug that is nothing but a date still names a folder', () => {
  const runDir = runDirPath('/runs', '2026-08-13-', RUN_STAMP);
  assert.equal(path.basename(runDir), '2026-08-13_235525_2026-08-13-');
});

test('a date outside the start of a slug is preserved', () => {
  const runDir = runDirPath('/runs', 'plan4-2026-08-13-ceiling-scope', RUN_STAMP);
  assert.equal(path.basename(runDir), '2026-08-13_235525_plan4-2026-08-13-ceiling-scope');
});

test('run directory collisions still receive a numeric suffix', (t) => {
  const root = makeTempTree('slug-collision-');
  t.after(() => removeTempTree(root));
  const base = runDirPath(root, '2026-08-13_plan4', RUN_STAMP);

  assert.equal(makeRunDir(base), base);
  assert.equal(makeRunDir(base), `${base}-2`);
});

test('an old generic-slug folder is found by order id and task fingerprint', () => {
  const orderId = 'plan-29-legacy-order';
  const hash = taskFingerprint('Preserve the old chain as an audit trail.');
  const root = makeChainRoot([
    {
      name: '2026-08-04_203514_build',
      slug: 'build',
      orderId,
      taskHash: hash,
      at: '2026-08-04T20:35:14Z',
    },
  ]);

  assert.deepEqual(chainRuns(root, CHAIN_REPO, 'plan-29-new-order', '', orderId), [
    '2026-08-04_203514_build',
  ]);
  assert.deepEqual(chainRuns(root, CHAIN_REPO, 'plan-29-new-order', hash, ''), [
    '2026-08-04_203514_build',
  ]);
});

test('parseArgs refuses a separator-only order id with the flag name and exit code 2', () => {
  // raw argv: this case tests the order-id flag refusal rather than an ordinary runner start.
  const script = `
import { parseArgs } from ${JSON.stringify(ARGS_MODULE)};
try { parseArgs(JSON.parse(process.env.CODEX_SLUG_ARGS)); }
catch (err) { process.exitCode = err.exitCode || 1; }
`;
  const output = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CODEX_SLUG_ARGS: JSON.stringify(reviewArgs('...')) },
    encoding: 'utf8',
  });
  assert.equal(output.status, 2, output.stderr);
  assert.equal(output.stderr.trim(),
    'run-codex: --order-id produces an unusable run folder name after sanitization: "..." must contain a letter or digit.');
});
