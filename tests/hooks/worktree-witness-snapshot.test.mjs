/** Plan_73 B3: the advisory witness uses the codec's version and exact-name rules. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encodeSnapshot } from '../../src/home/lib/meta/snapshot-format.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

const WITNESS_URL = new URL('../../src/home/hooks/worktree-witness.mjs', import.meta.url);
const WITNESS = fileURLToPath(WITNESS_URL);
const GIT_STATE_URL = new URL('../../src/home/lib/runner/git-state.mjs', import.meta.url);
const dataModule = (source) => `data:text/javascript,${encodeURIComponent(source)}`;

async function fixture(t, baseline) {
  const root = makeTempTree('bridge-witness-snapshot-');
  const repo = path.join(root, 'repository');
  const runsRoot = path.join(root, 'runs');
  const dir = path.join(runsRoot, 'project', '2026-09-30_snapshot-codec');
  await fs.mkdir(repo, { recursive: true });
  await fs.mkdir(dir, { recursive: true });
  assert.equal(spawnSync('git', ['init', '-q', repo]).status, 0);
  assert.equal(spawnSync('git', [
    '-C', repo, '-c', 'user.name=Witness Snapshot', '-c', 'user.email=witness@example.test',
    'commit', '--allow-empty', '-qm', 'fixture baseline',
  ]).status, 0);
  t.after(() => removeTempTree(root));
  await fs.writeFile(path.join(dir, 'status.json'), JSON.stringify({
    state: 'running', pid: process.pid, process_started_at: performance.timeOrigin,
    agent: 'codex-build', slug: 'snapshot-codec', repo,
    started_at: new Date(performance.timeOrigin).toISOString(),
  }));
  await fs.writeFile(path.join(dir, 'state-before.txt'), baseline);
  await fs.writeFile(path.join(dir, 'scope.txt'), 'src/**\n');
  return { root, repo, runsRoot };
}

function runWitness({ root, repo, runsRoot }, currentSnapshot) {
  const args = [];
  if (currentSnapshot !== undefined) {
    // B4 owns the v2 writer. Simulate its output only at the snapshot boundary while
    // retaining the real git repository check, live-run lookup and hook execution.
    const replacement = dataModule(`
      export { git } from ${JSON.stringify(GIT_STATE_URL.href)};
      export const worktreeSnapshot = () => process.env.WITNESS_CURRENT_SNAPSHOT;
    `);
    const loader = dataModule(`
      import { registerHooks } from 'node:module';
      registerHooks({ resolve(specifier, context, nextResolve) {
        if (context.parentURL === ${JSON.stringify(WITNESS_URL.href)}
            && specifier === '../lib/runner/git-state.mjs') {
          return { url: ${JSON.stringify(replacement)}, shortCircuit: true };
        }
        return nextResolve(specifier, context);
      } });
    `);
    args.push('--import', loader);
  }
  return spawnSync(process.execPath, [...args, WITNESS], {
    input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', cwd: repo,
      tool_input: { command: 'write fixture' } }),
    encoding: 'utf8',
    env: { ...process.env, CODEX_RUNS_ROOT: runsRoot, HOME: root, USERPROFILE: root,
      WITNESS_CURRENT_SNAPSHOT: currentSnapshot ?? '' },
  });
}

test('a v2 baseline names a Cyrillic stray outside the scope exactly', async (t) => {
  const context = await fixture(t, encodeSnapshot([]));
  const stray = 'документы/проверка.md';
  const current = encodeSnapshot([
    { path: 'src/разрешено.mjs', state: '1\t0' },
    { path: stray, state: '1\t0' },
  ]);
  const result = runWitness(context, current);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout).hookSpecificOutput;
  assert.equal(output.hookEventName, 'PostToolUse');
  assert.ok(output.additionalContext.includes(`outside its scope: ${stray}. Act now:`));
  assert.ok(!output.additionalContext.includes('разрешено.mjs'));
  const reported = output.additionalContext.split('outside its scope: ')[1].split('. Act now:')[0];
  assert.equal(reported, stray);
});

test('a v2 baseline with the current legacy writer stays silent', async (t) => {
  const context = await fixture(t, encodeSnapshot([]));
  await fs.writeFile(path.join(context.repo, 'outside.txt'), 'real stray\n');
  const result = runWitness(context);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('a legacy baseline with a future v2 writer stays silent', async (t) => {
  const context = await fixture(t, '');
  const result = runWitness(context, encodeSnapshot([{ path: 'outside.txt', state: '1\t0' }]));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('a damaged or quoted baseline provides no evidence of a stray edit', async (t) => {
  for (const baseline of ['broken\n', '1\t0\t"quoted.txt"\n']) {
    const context = await fixture(t, baseline);
    const result = runWitness(context, encodeSnapshot([{ path: 'outside.txt', state: '1\t0' }]));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
  }
});
