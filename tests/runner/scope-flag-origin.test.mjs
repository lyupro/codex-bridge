/**
 * OW-042 B1: the scope unit tests passed separate lists while args.mjs merges --scope-new into --scope, so a
 * --scope-new refusal still read "--scope pattern" on the live runner. This drives the real runner end to end.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

const RUN_CODEX = fileURLToPath(new URL('../../src/home/lib/run-codex.mjs', import.meta.url));

function runner(t, scopeArgs) {
  const root = makeTempTree('scope-flag-origin-');
  t.after(() => removeTempTree(root));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'a.mjs'), 'export const v = 42;\n');
  fs.writeFileSync(path.join(repo, 'src', 'x.mjs'), 'export default 1;\n');
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: repo }).status, 0);
  const taskFile = path.join(root, 'task.md');
  fs.writeFileSync(taskFile, 'advice: mechanical\n\n# probe\n\nDo nothing.\n\n## Verify\n\n`node -e 0`\n');
  const runs = path.join(root, 'runs');
  const output = spawnSync(process.execPath, [
    RUN_CODEX, '--agent', 'codex-build', '--repo', repo, '--order-id', 'scope-flag-origin',
    '--task-file', taskFile, ...scopeArgs,
  ], { cwd: repo, env: { ...process.env, CODEX_RUNS_ROOT: runs }, input: '', encoding: 'utf8' });
  return { output, runs };
}

test('a directory given only to --scope-new is refused under its own flag', (t) => {
  const { output, runs } = runner(t, ['--scope', 'a.mjs', '--scope-new', 'src/']);
  assert.equal(output.status, 2, output.stderr);
  assert.match(output.stderr, /--scope-new pattern "src\/" refused: names a directory rather than a file/);
  assert.equal(fs.existsSync(runs) ? fs.readdirSync(runs).length : 0, 0);
});

test('a directory given to --scope is still refused as --scope', (t) => {
  const { output } = runner(t, ['--scope', 'a.mjs,src/']);
  assert.equal(output.status, 2, output.stderr);
  assert.match(output.stderr, /(^|\s)--scope pattern "src\/" refused: names a directory rather than a file/);
});
