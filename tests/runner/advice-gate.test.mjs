/** Plan_59 D5/D6: design gates must refuse before a probe or run folder exists. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeTempTree } from '../temp-tree.mjs';
import { fixtureTask, launcherProcessMocks } from './launcher-mocks.mjs';
import { taskPreflight } from '../../src/home/lib/runner/preflight.mjs';

const LAUNCHER = new URL('../../src/home/lib/runner/launcher.mjs', import.meta.url).href;
const CLEAN_TASK = '## Options\n- keep: Keep the boundary.\n- split: Split the boundary.\n## Paths\n- source.mjs\n';
const FREE = /The run folder was not created; quota was not spent\.\s*$/;

function fixture() {
  const root = makeTempTree('advice-gate-');
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  const runs = path.join(repo, 'runs');
  fs.mkdirSync(repo);
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(repo, 'source.mjs'), 'export default 1;\n');
  return { root, repo, home, runs };
}

function launch(tree, agent, taskText, { refuse = false, taskFile = false } = {}) {
  const args = ['--agent', agent, '--repo', tree.repo, '--order-id', 'advice-fixture',
    ...(agent === 'codex-advisor' ? ['--phase', 'scope'] : []),
    ...(agent === 'codex-build' ? ['--scope', 'source.mjs'] : []),
    ...(agent === 'codex-scout' ? ['--question', 'What does source.mjs export?'] : [])];
  if (taskFile) {
    const file = path.join(tree.root, 'task.md');
    fs.writeFileSync(file, taskText);
    args.push('--task-file', file);
  }
  const source = `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
${launcherProcessMocks({ worker: refuse ? 'forbidden' : 'spawn', probe: refuse ? 'forbidden' : 'marker' })}
syncBuiltinESMExports();
const { launcher } = await import(${JSON.stringify(LAUNCHER)});
try { process.exitCode = await launcher(${JSON.stringify(args)}); }
catch (error) {
  if (typeof error?.exitCode !== 'number') throw error;
  process.exitCode = error.exitCode;
}
`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: tree.repo, input: taskFile ? '' : taskText, encoding: 'utf8', timeout: 10_000, windowsHide: true,
    env: { ...process.env, CODEX_BRIDGE_HOME: tree.home, CODEX_RUNS_ROOT: tree.runs },
  });
}

function statusFrom(output) {
  assert.equal(output.status, 0, output.stderr || output.error?.message);
  const line = output.stdout.split(/\r?\n/).find((line) => line.startsWith('RUN='));
  assert.ok(line, output.stdout);
  return JSON.parse(fs.readFileSync(path.join(line.slice(4).split(' order-id=')[0], 'status.json'), 'utf8'));
}

const JUDGED_ADVICE = { agent: 'codex-advisor', phase: 'advise', status: 'OK' };

function assertFree(tree, output) {
  assert.equal(output.status, 1, output.stderr || output.error?.message);
  assert.equal(output.stdout, '');
  assert.match(output.stderr, FREE);
  assert.equal(fs.existsSync(tree.runs), false);
  assert.deepEqual(fs.readdirSync(tree.repo), ['source.mjs']);
}

for (const advice of ['mechanical', 'revert', 'docs-only', 'test-only']) {
  test(`build accepts ${advice} and persists advice in status`, () => {
    const text = advice === 'mechanical' ? fixtureTask('codex-build', 'Edit source.') : `Edit source.\nadvice: ${advice}`;
    assert.equal(statusFrom(launch(fixture(), 'codex-build', text)).advice, advice);
  });
}

test('advice label is case-insensitive, list-item and whitespace tolerant, including task files', () => {
  const output = launch(fixture(), 'codex-build', 'Edit source.\r\n \t-  AdViCe \t: \t docs-only \t\r\n', { taskFile: true });
  assert.equal(statusFrom(output).advice, 'docs-only');
});

test('an absolute advisor run path with spaces passes and is persisted', () => {
  const tree = fixture();
  const advisorRun = path.join(tree.root, 'finished advisor');
  fs.mkdirSync(advisorRun);
  fs.writeFileSync(path.join(advisorRun, 'meta.json'), JSON.stringify(JUDGED_ADVICE));
  assert.equal(statusFrom(launch(tree, 'codex-build', `Edit source.\nadvice: ${advisorRun}`)).advice, advisorRun);
});

test('advisor metadata uses the shared BOM-tolerant JSON reader', () => {
  const tree = fixture();
  fs.writeFileSync(path.join(tree.home, 'meta.json'), `\uFEFF${JSON.stringify(JUDGED_ADVICE)}\n`);
  assert.equal(statusFrom(launch(tree, 'codex-build', `advice: ${tree.home}`)).advice, tree.home);
});

const invalid = {
  missing: () => 'Edit source.',
  duplicate: () => 'advice: mechanical\n - ADVICE: revert',
  empty: () => 'advice: \nEdit source.',
  'free text': () => 'advice: the best choice',
  'inline label': () => 'Edit source with advice: mechanical',
  'wrong value case': () => 'advice: Mechanical',
  relative: () => 'advice: ./advisor',
  'nonexistent path': (tree) => `advice: ${path.join(tree.root, 'missing')}`,
  'directory without meta': (tree) => `advice: ${tree.home}`,
  'file path': (tree) => `advice: ${path.join(tree.repo, 'source.mjs')}`,
  'another agent': (tree) => {
    fs.writeFileSync(path.join(tree.home, 'meta.json'), JSON.stringify({ agent: 'codex-scout' }));
    return `advice: ${tree.home}`;
  },
  // Plan_59 D26: an advisor folder authorizes a build only as a judged, successful advise pass.
  'advisor scope run': (tree) => {
    fs.writeFileSync(path.join(tree.home, 'meta.json'), JSON.stringify({ ...JUDGED_ADVICE, phase: 'scope' }));
    return `advice: ${tree.home}`;
  },
  'failed advise run': (tree) => {
    fs.writeFileSync(path.join(tree.home, 'meta.json'), JSON.stringify({ ...JUDGED_ADVICE, status: 'FAIL' }));
    return `advice: ${tree.home}`;
  },
  'advisor run without phase': (tree) => {
    fs.writeFileSync(path.join(tree.home, 'meta.json'), JSON.stringify({ agent: 'codex-advisor', status: 'OK' }));
    return `advice: ${tree.home}`;
  },
  'malformed meta': (tree) => {
    fs.writeFileSync(path.join(tree.home, 'meta.json'), '{');
    return `advice: ${tree.home}`;
  },
};
for (const [name, task] of Object.entries(invalid)) {
  test(`build refuses ${name} without a probe or run folder`, () => {
    const tree = fixture();
    const output = launch(tree, 'codex-build', task(tree), { refuse: true });
    assertFree(tree, output);
    assert.match(output.stderr, /mechanical \| revert \| docs-only \| test-only/);
    assert.match(output.stderr, /absolute path.*meta\.json.*codex-advisor/);
    assert.match(output.stderr, /an order that invents a construction needs a second opinion first; only work with no design choice may skip it/i);
  });
}

for (const agent of ['codex-scout', 'codex-review', 'codex-advisor']) {
  test(`${agent} runs without advice and has no advice status field`, () => {
    const task = agent === 'codex-advisor' ? CLEAN_TASK : 'Inspect source.';
    assert.equal(Object.hasOwn(statusFrom(launch(fixture(), agent, task)), 'advice'), false);
  });
}

// Plan_59 D5: retain the task-boundary guard alongside launcher coverage in advisor-run.test.mjs.
test('biased advisor task is refused by the task gate with the free-refusal sentence', () => {
  const text = CLEAN_TASK.replace('Keep the boundary.', 'Keep the boundary (recommended).');
  const { refusal } = taskPreflight({ agent: 'codex-advisor', taskText: text });
  assert.match(refusal, /remove preference marker/);
  assert.match(refusal, /The run folder was not created; quota was not spent\.$/);
});

test('clean advisor task is not refused by the task gate', () => {
  assert.equal(taskPreflight({ agent: 'codex-advisor', taskText: CLEAN_TASK }).refusal, null);
});
