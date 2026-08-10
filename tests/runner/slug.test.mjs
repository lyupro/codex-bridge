/** Regression coverage for Plan_29 slug derivation and legacy chain lookup. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chainRuns, taskFingerprint } from '../../src/meta/chain.mjs';
import { parseArgs } from '../../src/runner/args.mjs';
import { makeChainRoot, CHAIN_REPO } from '../meta/test-fixtures.mjs';

const ARGS_MODULE = new URL('../../src/runner/args.mjs', import.meta.url).href;

function reviewArgs(orderId, slug) {
  return [
    '--agent', 'codex-review',
    '--repo', CHAIN_REPO,
    ...(slug === undefined ? [] : ['--slug', slug]),
    '--order-id', orderId,
  ];
}

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
