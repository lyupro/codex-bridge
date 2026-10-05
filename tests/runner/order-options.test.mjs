/** Direct normalisation coverage for the channel extraction required by Plan_63 D5. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { orderOptions } from '../../src/home/lib/runner/order-options.mjs';
import { chainRuns } from '../../src/home/lib/meta/chain.mjs';
import { makeChainRoot, CHAIN_REPO } from '../meta/test-fixtures.mjs';

function normalise(entries, settings) {
  return orderOptions('codex-review', new Map(entries), settings);
}

test('an order without a slug derives the slug from its trimmed order id', () => {
  const { options, problems } = normalise([['order id', '  plan/29:slug-default  ']]);
  assert.equal(options.orderId, 'plan/29:slug-default');
  assert.equal(options.slug, 'plan-29-slug-default');
  assert.deepEqual(problems, []);
});

test('different order ids do not collapse into one default-slug chain', () => {
  const { options: first } = normalise([['order id', 'plan/29:first']]);
  const { options: second } = normalise([['order id', 'plan/29:second']]);
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

test('an explicit slug wins and is sanitized while dots, underscores and hyphens survive', () => {
  const { options, problems } = normalise([
    ['order id', 'plan/29:order-id'], ['slug', 'manual slug/one._-'],
  ]);
  assert.equal(options.slug, 'manual-slug-one._-');
  assert.deepEqual(problems, []);
});

for (const label of ['order id', 'slug']) {
  for (const value of ['...', '___', '   ']) {
    test(label + ' ' + JSON.stringify(value) + ' reports an unusable slug with its own label', () => {
      const entries = label === 'slug' ? [['order id', 'ord-1'], [label, value]] : [[label, value]];
      const { options, problems } = normalise(entries);
      const slug = value === '   ' ? (label === 'slug' ? '-' : '') : value;
      assert.equal(options.slug, slug);
      assert.deepEqual(problems, [{ label,
        reason: 'produces an unusable run folder name after sanitization: ' + JSON.stringify(slug) +
          ' must contain a letter or digit.' }]);
    });
  }
}

test('normalisation leaves effort support to Codex at launch', () => {
  for (const effort of ['minimal', 'ultra', 'none', 'future-depth']) {
    const { options, problems } = normalise([['order id', 'ord-1'], ['effort', effort]]);
    assert.equal(options.effort, effort);
    assert.deepEqual(problems, []);
  }
});

test('empty or whitespace-containing efforts produce channel-neutral problems', () => {
  for (const effort of ['', ' ', 'two words', ' leading', 'trailing ', 'line\nbreak']) {
    const { options, problems } = normalise([['order id', 'ord-1'], ['effort', effort]]);
    assert.equal(options.effort, effort);
    assert.deepEqual(problems, [{ label: 'effort',
      reason: 'must be a non-empty single word with no whitespace; got ' + JSON.stringify(effort) }]);
  }
});

test('changeset defaults to uncommitted and preserves explicit values', () => {
  for (const changeset of [undefined, '', 'HEAD~1..HEAD']) {
    const entries = [['order id', 'ord-1']];
    if (changeset !== undefined) entries.push(['changeset', changeset]);
    assert.equal(normalise(entries).options.changeset, changeset || 'uncommitted');
  }
});

test('repository uses the supplied cwd when absent or empty and resolves explicit paths', () => {
  const cwd = path.resolve('order-options-cwd');
  for (const repository of [undefined, '', path.join(cwd, 'repo'), 'relative-repo']) {
    const entries = [['order id', 'ord-1']];
    if (repository !== undefined) entries.push(['repository', repository]);
    assert.equal(normalise(entries, { cwd }).options.repo, path.resolve(repository || cwd));
  }
  assert.equal(normalise([['order id', 'ord-1']]).options.repo, process.cwd());
});

test('scope and scope new merge in declaration order without empty patterns', () => {
  const { options, problems } = normalise([
    ['order id', 'ord-1'], ['scope', ' src/**, , tests/**,'],
    ['scope new', ', new/a.mjs, new/b.mjs ,'],
  ]);
  assert.deepEqual(options.scopePatterns, ['src/**', 'tests/**', 'new/a.mjs', 'new/b.mjs']);
  assert.deepEqual(options.scopeNewPatterns, ['new/a.mjs', 'new/b.mjs']);
  assert.deepEqual(problems, []);
});

test('absent effort and phase create no options and an explicit phase is untouched', () => {
  const { options } = normalise([['order id', 'ord-1']]);
  assert.deepEqual(Object.keys(options).sort(),
    ['changeset', 'orderId', 'repo', 'scopeNewPatterns', 'scopePatterns', 'slug']);
  assert.deepEqual(options.scopePatterns, []);
  assert.deepEqual(options.scopeNewPatterns, []);
  for (const phase of ['', '  phase one  ']) {
    assert.equal(normalise([['order id', 'ord-1'], ['phase', phase]]).options.phase, phase);
  }
});

test('normalisation does not enforce agent acceptance, required scope or shell safety', () => {
  for (const agent of ['codex-build', 'codex-scout', 'unknown-agent']) {
    const { options, problems } = orderOptions(agent,
      new Map([['order id', 'ord;1'], ['scope new', 'new.mjs']]));
    assert.equal(options.slug, 'ord-1');
    assert.deepEqual(options.scopePatterns, ['new.mjs']);
    assert.deepEqual(problems, []);
  }
  const { options, problems } = normalise([]);
  assert.equal(options.orderId, '');
  assert.deepEqual(problems, [{ label: 'order id',
    reason: 'produces an unusable run folder name after sanitization: "" must contain a letter or digit.' }]);
});

test('effort problems precede slug problems and empty explicit slugs retain their label', () => {
  const { options, problems } = normalise([['order id', '...'], ['slug', ''], ['effort', 'two words']]);
  assert.equal(options.slug, '...');
  assert.deepEqual(problems.map(({ label }) => label), ['effort', 'slug']);
});
