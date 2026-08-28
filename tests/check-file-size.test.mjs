/**
 * Verifies the check-file-size gate's decision logic: pass/fail thresholds, exclude
 * handling, mode vs --error precedence, --json output, and config-error handling. Every
 * fixture is a throwaway temp directory — nothing here depends on real repo content.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { run, isSpecificExclude } from '../scripts/check-file-size.mjs';
import { makeTempTree, removeTempTree } from './temp-tree.mjs';

/** Builds a file with an exact number of lines: N-1 newlines, split('\n').length === N. */
function linesOf(count) {
  return Array.from({ length: count }, (_, i) => `// line ${i}`).join('\n');
}

function baseConfig(overrides = {}) {
  return {
    maxLines: 10,
    mode: 'error',
    baselineDate: '2026-08-01',
    include: ['**/*.mjs'],
    exclude: [],
    exclusionRationale: {},
    ...overrides,
  };
}

/** Creates a temp fixture repo: writes files + a config, returns paths and an auto-cleanup. */
async function makeFixture(t, files, config) {
  const rootDir = makeTempTree('check-file-size-');
  t.after(() => removeTempTree(rootDir));

  for (const [relPath, content] of Object.entries(files)) {
    const full = path.join(rootDir, relPath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }

  const configPath = path.join(rootDir, '.file-size-limit.json');
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  return { rootDir, configPath };
}

test('a file within the limit passes', async (t) => {
  const { rootDir, configPath } = await makeFixture(
    t,
    { 'small.mjs': linesOf(5) },
    baseConfig(),
  );
  const result = await run({ rootDir, configPath });
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /1 file\(s\) checked/);
});

test('a file over the limit fails in error mode', async (t) => {
  const { rootDir, configPath } = await makeFixture(
    t,
    { 'big.mjs': linesOf(20) },
    baseConfig({ mode: 'error' }),
  );
  const result = await run({ rootDir, configPath });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /big\.mjs/);
});

test('an excluded over-limit file does not fail', async (t) => {
  const { rootDir, configPath } = await makeFixture(
    t,
    { 'big.mjs': linesOf(20) },
    baseConfig({
      mode: 'error',
      exclude: ['big.mjs'],
      exclusionRationale: { 'big.mjs': 'fixture: deliberately oversized, excluded on purpose' },
    }),
  );
  const result = await run({ rootDir, configPath });
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /0 file\(s\) checked|all within/);
});

test('warning mode exits 0 despite violators', async (t) => {
  const { rootDir, configPath } = await makeFixture(
    t,
    { 'big.mjs': linesOf(20) },
    baseConfig({ mode: 'warning' }),
  );
  const result = await run({ rootDir, configPath });
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /big\.mjs/);
});

test('--error overrides mode "warning" from config', async (t) => {
  const { rootDir, configPath } = await makeFixture(
    t,
    { 'big.mjs': linesOf(20) },
    baseConfig({ mode: 'warning' }),
  );
  const result = await run({ argv: ['--error'], rootDir, configPath });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /big\.mjs/);
});

test('--json prints valid JSON with a violators field', async (t) => {
  const { rootDir, configPath } = await makeFixture(
    t,
    { 'big.mjs': linesOf(20), 'small.mjs': linesOf(3) },
    baseConfig({ mode: 'error' }),
  );
  const result = await run({ argv: ['--json'], rootDir, configPath });
  assert.equal(result.exitCode, 1);
  const payload = JSON.parse(result.output);
  assert.ok(Array.isArray(payload.violators));
  assert.equal(payload.violators.length, 1);
  assert.equal(payload.violators[0].path, 'big.mjs');
  assert.equal(payload.filesChecked, 2);
});

test('a missing config file gives exit 2', async (t) => {
  const rootDir = makeTempTree('check-file-size-');
  t.after(() => removeTempTree(rootDir));
  const result = await run({ rootDir, configPath: path.join(rootDir, 'nope.json') });
  assert.equal(result.exitCode, 2);
});

test('a malformed config file gives exit 2', async (t) => {
  const rootDir = makeTempTree('check-file-size-');
  t.after(() => removeTempTree(rootDir));
  const configPath = path.join(rootDir, '.file-size-limit.json');
  await fs.writeFile(configPath, '{ this is not json');
  const result = await run({ rootDir, configPath });
  assert.equal(result.exitCode, 2);
});

test('a specific-path exclude without exclusionRationale gives exit 2', async (t) => {
  const { rootDir, configPath } = await makeFixture(
    t,
    { 'big.mjs': linesOf(20) },
    baseConfig({ exclude: ['big.mjs'], exclusionRationale: {} }),
  );
  const result = await run({ rootDir, configPath });
  assert.equal(result.exitCode, 2);
  assert.match(result.output, /exclusionRationale/);
});

test('a pattern exclude (contains *) needs no exclusionRationale entry', async (t) => {
  const { rootDir, configPath } = await makeFixture(
    t,
    { 'big.mjs': linesOf(20) },
    baseConfig({ exclude: ['**/*.mjs'], exclusionRationale: {} }),
  );
  const result = await run({ rootDir, configPath });
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /0 file\(s\) checked/);
});

test('isSpecificExclude distinguishes a bare path from a glob pattern', () => {
  assert.equal(isSpecificExclude('agents/codex-bridge/run-codex.mjs'), true);
  assert.equal(isSpecificExclude('**/node_modules/**'), false);
  assert.equal(isSpecificExclude('plugins/**'), false);
});
