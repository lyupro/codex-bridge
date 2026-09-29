/** Guards Plan_71 D1: usage hints belong to syntax refusals, not value failures (advice A1). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { model } from '../../cli/model.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

function fixture(t) {
  const root = makeTempTree('model-help-');
  t.after(() => removeTempTree(root));
  const configPath = path.join(root, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ models: {} }));
  return {
    configPath,
    codexHome: root,
    fetchCatalogue: () => assert.fail('syntax and role refusals must not fetch the catalogue'),
  };
}

test('bare model ends with the exact set and catalogue hint', async (t) => {
  const result = await model([], fixture(t));
  assert.equal(result.exitCode, 0);
  assert.equal(result.output.split('\n').at(-2), 'Machine-wide: shared by every project on this machine, not per-project.');
  assert.equal(result.output.split('\n').at(-1), 'Set: codex-bridge model set <role> <model> [effort] · catalogue: codex-bridge model list');
});

test('model list does not include the profile set hint', async (t) => {
  const result = await model(['list'], {
    ...fixture(t),
    fetchCatalogue: () => JSON.stringify({ models: [] }),
  });
  assert.equal(result.exitCode, 0);
  assert.doesNotMatch(result.output, /Set:/);
});

test('unknown model action ends with the model help pointer', async (t) => {
  const result = await model(['bogus'], fixture(t));
  assert.equal(result.exitCode, 2);
  assert.equal(result.output, 'codex-bridge model: unknown action "bogus". Use model, model list, model set, model unset or model speed.\nRun codex-bridge model -h for usage.');
});

test('unexpected model argument ends with the model help pointer', async (t) => {
  const result = await model(['--json'], fixture(t));
  assert.equal(result.exitCode, 2);
  assert.equal(result.output, 'codex-bridge model: unexpected argument "--json".\nRun codex-bridge model -h for usage.');
});

test('extra set positional argument ends with the set help pointer', async (t) => {
  const result = await model(['set', 'build', 'm', 'high', 'extra'], fixture(t));
  assert.equal(result.exitCode, 2);
  assert.equal(result.output, 'codex-bridge model: unexpected argument "extra".\nRun codex-bridge model set -h for usage.');
});

test('unknown set flag ends with the set help pointer', async (t) => {
  const result = await model(['set', 'build', '--bogus', 'x'], fixture(t));
  assert.equal(result.exitCode, 2);
  assert.equal(result.output, 'codex-bridge model: unexpected argument "--bogus".\nRun codex-bridge model set -h for usage.');
});

test('extra unset argument ends with the unset help pointer', async (t) => {
  const result = await model(['unset', 'build', 'extra'], fixture(t));
  assert.equal(result.exitCode, 2);
  assert.equal(result.output, 'codex-bridge model: unexpected argument "extra".\nRun codex-bridge model unset -h for usage.');
});

test('unknown role keeps its allowed-values refusal without a help pointer', async (t) => {
  const result = await model(['set', 'nosuchrole', 'm'], fixture(t));
  assert.equal(result.exitCode, 2);
  assert.equal(result.output, 'codex-bridge model: unknown role "nosuchrole". Allowed roles: scout, build, review, advisor.');
  assert.doesNotMatch(result.output, /Run codex-bridge .* -h for usage\./);
});
