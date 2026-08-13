/** Regression coverage for Plan_29 slug derivation and legacy chain lookup. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chainRuns, taskFingerprint } from '../../src/meta/chain.mjs';
import { parseArgs } from '../../src/runner/args.mjs';
import { makeRunDir, runDirPath } from '../../src/runner/launcher.mjs';
import { makeChainRoot, CHAIN_REPO } from '../meta/test-fixtures.mjs';

const ARGS_MODULE = new URL('../../src/runner/args.mjs', import.meta.url).href;
const RUN_STAMP = '2026-08-13_235525';

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slug-collision-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = runDirPath(root, '2026-08-13_plan4', RUN_STAMP);

  assert.equal(makeRunDir(base), base);
  assert.equal(makeRunDir(base), `${base}-2`);
});

test('an order without --slug derives the slug from its order id', () => {
  const options = parseArgs(reviewArgs('plan/29:slug-default'));
  assert.equal(options.slug, 'plan-29-slug-default');
});

test('different order ids do not collapse into one default-slug chain', () => {
  const first = parseArgs(reviewArgs('plan/29:first'));
  const second = parseArgs(reviewArgs('plan/29:second'));
  const root = makeChainRoot([
    {
      name: '2026-08-10_090000_plan-29-first',
      slug: first.slug,
      orderId: first.orderId,
      at: '2026-08-10T09:00:00Z',
    },
  ]);

  assert.notEqual(first.slug, second.slug);
  assert.deepEqual(chainRuns(root, CHAIN_REPO, second.slug, '', second.orderId), []);
});

test('an explicit --slug still wins and is sanitized', () => {
  const options = parseArgs(reviewArgs('plan/29:order-id', 'manual slug/one'));
  assert.equal(options.slug, 'manual-slug-one');
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

test('an order id that sanitizes to empty or separator-only slug is refused', () => {
  const script = `
import { parseArgs } from ${JSON.stringify(ARGS_MODULE)};
parseArgs(JSON.parse(process.env.CODEX_SLUG_ARGS));
`;

  for (const orderId of ['...', '___', '   ']) {
    const output = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, CODEX_SLUG_ARGS: JSON.stringify(reviewArgs(orderId)) },
      encoding: 'utf8',
    });
    assert.equal(output.status, 2, `${orderId}: ${output.stderr}`);
    assert.match(output.stderr, /--order-id.*(required|unusable|letter or digit)/i);
  }
});
