/** Verifies uninstall-side removal questions for incomplete inventories (Plan_65 D9). */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { askRemoval, lastOwnerQuestion, orphanQuestion, removalHint } from '../../cli/inventory-removal.mjs';
import { normalizedRulesOwner, RULES_REGISTRY_VERSION, rulesRegistryPath } from '../../cli/rules-owners.mjs';
import { resolveHost } from '../../cli/hosts.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

const KINDS = ['last-owner', 'orphan'];

async function fixture(t) {
  const root = makeTempTree('bridge-inventory-removal-');
  t.after(() => removeTempTree(root));
  const host = resolveHost({
    host: path.join(root, 'host'),
    codexHome: path.join(root, 'codex-home'),
    brandRoot: path.join(root, 'brand'),
  });
  const ownRoot = normalizedRulesOwner(host);
  const otherRoot = normalizedRulesOwner({ root: path.join(root, 'other-host') });
  return { host, ownRoot, otherRoot };
}

function countingPrompt(answer) {
  const prompt = async (question) => {
    prompt.calls += 1;
    prompt.question = question;
    return answer;
  };
  prompt.calls = 0;
  return prompt;
}

function assertHintShowsOnly(question, shown, hidden) {
  const lines = question.split('\n');
  assert.ok(lines.includes(`  ${shown}`));
  assert.ok(!lines.includes(`  ${hidden}`));
}

test('last-owner question names the home, departing host, and other registry roots', async (t) => {
  const { host, ownRoot, otherRoot } = await fixture(t);

  const question = lastOwnerQuestion(host, [ownRoot, otherRoot]);

  assert.equal(question.split('\n')[0], `Home: ${host.brandRoot}`);
  assert.ok(question.includes(`Known owners: only this host (${host.root}), which is leaving.`));
  assert.ok(question.includes('an old installation record did not name every host that used this home.'));
  assertHintShowsOnly(question, otherRoot, ownRoot);
  assert.ok(question.includes(`Is ${host.root} the last host using this home? Yes removes the shared image`));
  assert.ok(question.endsWith('config.json, conventions.md and run data stay.'));
});

test('orphan question names the home, host settings, and other registry roots', async (t) => {
  const { host, ownRoot, otherRoot } = await fixture(t);

  const question = orphanQuestion(host, [ownRoot, otherRoot]);

  assert.equal(question.split('\n')[0], `Home: ${host.brandRoot}`);
  assert.ok(question.includes('No host is recorded as using this home, and the inventory is incomplete.'));
  assertHintShowsOnly(question, otherRoot, ownRoot);
  assert.ok(question.includes(`The settings of ${host.root} are not touched;`));
  assert.ok(question.endsWith('config.json, conventions.md and run data stay.'));
});

test('without a terminal both kinds keep the image and never prompt', async (t) => {
  const { host } = await fixture(t);
  const prompt = countingPrompt('yes');

  for (const kind of KINDS) {
    assert.equal(await askRemoval(host, kind, { isTTY: false, prompt }), 'keep');
  }

  assert.equal(prompt.calls, 0);
});

test('yes, no, and cancel map to remove, keep, and cancel for both kinds', async (t) => {
  const { host } = await fixture(t);
  const expected = { yes: 'remove', no: 'keep', cancel: 'cancel' };

  for (const kind of KINDS) {
    for (const [answer, outcome] of Object.entries(expected)) {
      const prompt = countingPrompt(answer);
      assert.equal(await askRemoval(host, kind, { isTTY: true, candidates: [], prompt }), outcome);
      assert.equal(prompt.calls, 1);
    }
  }
});

test('an unknown kind fails loudly even without a terminal', async (t) => {
  const { host } = await fixture(t);

  await assert.rejects(askRemoval(host, 'purge', { isTTY: false }), /Unknown inventory removal kind: purge/);
});

test('reads registry candidates when askRemoval receives none explicitly', async (t) => {
  const { host, ownRoot, otherRoot } = await fixture(t);
  await fs.mkdir(host.codexRulesDir, { recursive: true });
  const registry = { version: RULES_REGISTRY_VERSION, owners: [ownRoot, otherRoot] };
  await fs.writeFile(rulesRegistryPath(host), `${JSON.stringify(registry)}\n`);
  const prompt = countingPrompt('no');

  assert.equal(await askRemoval(host, 'orphan', { isTTY: true, prompt }), 'keep');

  assertHintShowsOnly(prompt.question, otherRoot, ownRoot);
});

test('removal hint names the host and shared home', async (t) => {
  const { host } = await fixture(t);

  const hint = removalHint(host);

  assert.ok(hint.startsWith(`Run codex-bridge uninstall --host "${host.root}" again in a terminal`));
  assert.ok(hint.endsWith(`no other host uses ${host.brandRoot} and remove it.`));
});
