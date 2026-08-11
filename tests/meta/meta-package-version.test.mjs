import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { collect } from '../../src/write-meta.mjs';
import { codexArgs } from '../../src/runner/codex-cmd.mjs';
import { loadRunEnv } from '../../src/runner/run-env.mjs';
import { buildResult, makeRun } from './test-fixtures.mjs';

const packageJson = JSON.parse(
  fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);

test('meta.json records the version of the runner package that wrote it', () => {
  const dir = makeRun({
    events: [{ type: 'thread.started', thread_id: 'runner-version' }],
    result: buildResult([]),
  });

  const { meta } = collect(dir, 'codex-build', 0);
  const written = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));

  assert.equal(meta.runner_version, packageJson.version);
  assert.equal(written.runner_version, packageJson.version);
});

test('every runner mode selects only a contract sandbox', () => {
  loadRunEnv();
  const runDir = path.join(os.tmpdir(), 'codex-run');
  const allowed = new Set(['read-only', 'workspace-write']);

  for (const agent of ['codex-scout', 'codex-build', 'codex-review']) {
    const args = codexArgs(
      { agent, effort: 'medium', repo: process.cwd(), models: {} },
      runDir,
      true,
    );
    assert.equal(args.filter((arg) => arg === '--sandbox').length, 1, agent);
    assert.equal(allowed.has(args[args.indexOf('--sandbox') + 1]), true, agent);
  }
});

test('a run without runner_version is reported as legacy without a sandbox warning', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runDir = path.join(root, 'project', '2026-07-29_2325_review-codex-agents');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'meta.json'),
    JSON.stringify({ tokens: 100, agent: 'codex-review', sandbox: 'danger-full-access' }),
  );

  const usage = fs.readFileSync(new URL('../../src/commands/usage.md', import.meta.url), 'utf8');
  const match = usage.match(/```bash\r?\nnode -e "\r?\n([\s\S]*?)\r?\n"\r?\n```/);
  assert.ok(match, 'usage command must remain an embedded node -e script');
  const result = spawnSync(process.execPath, ['-e', match[1]], {
    encoding: 'utf8',
    env: { ...process.env, CODEX_RUNS_ROOT: root },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /Before the runner: 1 runs carry no runner version and are not judged by the sandbox contract/,
  );
  assert.doesNotMatch(result.stdout, /WARNING: .*went outside the usual sandbox/);
});
