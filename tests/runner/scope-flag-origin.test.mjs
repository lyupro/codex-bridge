/**
 * OW-042 B1: the scope unit tests passed separate lists while the runner merges scope new: into scope:, so a
 * scope new: refusal still named scope:. Plan_63 D8 keeps the header channel. This drives the real runner end to end.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import { orderInvocation } from './order-invocation.mjs';

const RUN_CODEX = fileURLToPath(new URL('../../src/home/lib/run-codex.mjs', import.meta.url));

function runner(t, scopeOrder) {
  const root = makeTempTree('scope-flag-origin-');
  t.after(() => removeTempTree(root));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'a.mjs'), 'export const v = 42;\n');
  fs.writeFileSync(path.join(repo, 'src', 'x.mjs'), 'export default 1;\n');
  // raw argv: Git initializes the scope fixture, not a runner order (OW-042).
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: repo }).status, 0);
  const { argv } = orderInvocation({
    agent: 'codex-build',
    order: { repository: repo, 'order id': 'scope-flag-origin', ...scopeOrder },
    advice: 'mechanical', task: '# probe\n\nDo nothing.', verify: '`node -e 0`', dir: root,
  });
  const runs = path.join(root, 'runs');
  // raw argv: Node transports the helper header-backed invocation unchanged (Plan_63 D8).
  const output = spawnSync(process.execPath, [RUN_CODEX, ...argv],
    { cwd: repo, env: { ...process.env, CODEX_RUNS_ROOT: runs }, input: '', encoding: 'utf8' });
  return { output, runs };
}

test('a directory given only to scope new: is refused under its own label', (t) => {
  const { output, runs } = runner(t, { scope: 'a.mjs', 'scope new': 'src/' });
  assert.equal(output.status, 2, output.stderr);
  assert.match(output.stderr, /`scope new:` pattern "src\/" refused: names a directory rather than a file/);
  assert.equal(fs.existsSync(runs) ? fs.readdirSync(runs).length : 0, 0);
});

test('a directory given to scope: is still refused as scope:', (t) => {
  const { output } = runner(t, { scope: 'a.mjs,src/' });
  assert.equal(output.status, 2, output.stderr);
  assert.match(output.stderr, /(^|\s)`scope:` pattern "src\/" refused: names a directory rather than a file/);
});
