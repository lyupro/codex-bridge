/** Plan_77 D6: old addresses must be diagnosed before reading evidence or recreating the store. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import { launcherProcessMocks } from './launcher-mocks.mjs';
import { orderInvocation } from './order-invocation.mjs';
import { taskPreflight } from '../../src/home/lib/runner/preflight.mjs';

const LAUNCHER = new URL('../../src/home/lib/runner/launcher.mjs', import.meta.url).href;
const FREE = 'The run folder was not created; quota was not spent.';
const OVERRIDE = 'CODEX_RUNS_ROOT points under a retired runs root; remove it or set it to the new location.';

function fixture(t) {
  const root = makeTempTree('retired-root-refusal-');
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  const oldRoot = path.join(root, 'old runs');
  const runs = path.join(home, 'runs');
  const state = path.join(home, 'state');
  const retired = [{ root: oldRoot, movedAt: '2026-10-08T12:30:00.000Z' }];
  fs.mkdirSync(repo);
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(repo, 'source.mjs'), 'export default 1;\n');
  fs.writeFileSync(path.join(state, 'runs-root.json'), JSON.stringify({ version: 1, retired }));
  t.after(() => removeTempTree(root));
  return { root, repo, home, oldRoot, runs, retired };
}

function movedText(tree, suffix) {
  return `Run records moved from ${tree.oldRoot} to ${tree.runs}. ` +
    `Equivalent path: ${path.join(tree.runs, suffix)}. ` +
    'Update advice: or pass this new path explicitly. No path was remapped.';
}

function launch(tree, { advice, override = '' }) {
  const { argv } = orderInvocation({
    agent: 'codex-build',
    order: { repository: tree.repo, 'order id': 'retired-root-fixture', scope: 'source.mjs' },
    advice, task: 'Edit source.', dir: tree.root,
  });
  const source = `
import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
${launcherProcessMocks({ worker: 'forbidden', probe: 'forbidden' })}
// Plan_77 incidents preflight.mjs:46-58 and project-dir.mjs:84: absence alone cannot prove no I/O.
for (const name of ['statSync', 'readFileSync', 'existsSync', 'mkdirSync']) {
  const original = fs[name];
  fs[name] = (candidate, ...args) => {
    if (typeof candidate === 'string') {
      const relative = path.relative(${JSON.stringify(tree.oldRoot)}, candidate);
      if (relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
        process.stderr.write('RETIRED_FS_ACCESS: ' + name + '\\n');
        throw new Error('retired filesystem access forbidden');
      }
    }
    return original(candidate, ...args);
  };
}
syncBuiltinESMExports();
const { launcher } = await import(${JSON.stringify(LAUNCHER)});
try { process.exitCode = await launcher(${JSON.stringify(argv)}); }
catch (error) {
  if (typeof error?.exitCode !== 'number') throw error;
  process.exitCode = error.exitCode;
}
`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: tree.repo, encoding: 'utf8', timeout: 10_000, windowsHide: true,
    env: { ...process.env, CODEX_BRIDGE_HOME: tree.home, CODEX_RUNS_ROOT: override },
  });
}

function assertFree(tree, output, expected) {
  assert.equal(output.status, 1, output.stderr || output.error?.message);
  assert.equal(output.stdout, '');
  assert.equal(output.stderr.trim(), `run-codex: ${expected}\n${FREE}`);
  assert.equal(fs.existsSync(tree.oldRoot), false);
  assert.equal(fs.existsSync(tree.runs), false);
  assert.deepEqual(fs.readdirSync(tree.repo), ['source.mjs']);
  assert.deepEqual(fs.readdirSync(tree.home), ['state']);
}

for (const suffix of ['', 'Project/Run-ID']) {
  test(`launcher refuses retired advice before filesystem access (${suffix || 'root'})`, (t) => {
    const tree = fixture(t);
    assertFree(tree, launch(tree, { advice: path.join(tree.oldRoot, suffix) }), movedText(tree, suffix));
  });

  test(`launcher refuses a stale runs override before mkdir (${suffix || 'root'})`, (t) => {
    const tree = fixture(t);
    const override = path.join(tree.oldRoot, suffix);
    assertFree(tree, launch(tree, { advice: 'mechanical', override }), `${movedText(tree, suffix)}\n${OVERRIDE}`);
    assert.equal(fs.existsSync(override), false);
  });
}

test('taskPreflight refuses even readable retired evidence before any stat or read', (t) => {
  const tree = fixture(t);
  const advice = path.join(tree.oldRoot, 'Project', 'Run-ID');
  fs.mkdirSync(advice, { recursive: true });
  fs.writeFileSync(path.join(advice, 'meta.json'), JSON.stringify({
    agent: 'codex-advisor', phase: 'advise', status: 'OK',
  }));
  const stat = t.mock.method(fs, 'statSync');
  const read = t.mock.method(fs, 'readFileSync');
  const result = taskPreflight({
    agent: 'codex-build', taskText: 'Edit source.', header: { advice },
    resolution: { retired: tree.retired, homeRoot: tree.runs },
  });
  assert.equal(result.refusal, `${movedText(tree, 'Project/Run-ID')}\n${FREE}`);
  assert.equal(stat.mock.callCount(), 0);
  assert.equal(read.mock.callCount(), 0);
});
