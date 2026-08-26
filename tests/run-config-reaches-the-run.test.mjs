/** Guards that the launcher reads the operator's home config before assembling a run. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { withTempTree } from './temp-tree.mjs';

const RUN_ENV = new URL('../src/home/lib/runner/run-env.mjs', import.meta.url).href;
const CODEX_ARGS = new URL('../src/home/lib/runner/codex-args.mjs', import.meta.url).href;

test('the operator home profile reaches the assembled Codex command', async () => {
  await withTempTree('codex-brand-home-', async (brandHome) => {
    const model = 'operator-pinned-model';
    const effort = 'xhigh';
    fs.writeFileSync(
      path.join(brandHome, 'config.json'),
      `${JSON.stringify({ models: { build: { model, effort } } }, null, 2)}\n`,
    );

    const source = `
      import { loadRunEnv } from ${JSON.stringify(RUN_ENV)};
      import { codexArgs } from ${JSON.stringify(CODEX_ARGS)};
      loadRunEnv();
      const args = codexArgs(
        { agent: 'codex-build', repo: process.cwd() },
        ${JSON.stringify(path.join(brandHome, 'run'))},
        true,
      );
      process.stdout.write(JSON.stringify(args));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      encoding: 'utf8',
      env: { ...process.env, CODEX_BRIDGE_HOME: brandHome },
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const args = JSON.parse(result.stdout);
    assert.equal(args[args.indexOf('-m') + 1], model);
    assert.ok(args.includes(`model_reasoning_effort=${effort}`));
  });
});
