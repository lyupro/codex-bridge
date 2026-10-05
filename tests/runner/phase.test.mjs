/** D2: phases are runner choices, validated before a probe or run registration. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeTempTree } from '../temp-tree.mjs';
import { launcherProcessMocks } from './launcher-mocks.mjs';
import { orderInvocation } from './order-invocation.mjs';
import { resolveRunPhase } from '../../src/home/lib/runner/preflight.mjs';

const AGENTS = new URL('../../src/home/lib/agents.mjs', import.meta.url).href;
const RUNNER = new URL('../../src/home/lib/run-codex.mjs', import.meta.url).href;
const CONFIG = new URL('../../src/home/lib/run-config.mjs', import.meta.url);

function launch({ budget = 15, phase, overrides, refuse = false, agent = 'codex-scout', continue: isContinue = false, taskText } = {}) {
  const root = makeTempTree('run-phase-');
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  const runs = path.join(repo, 'runs');
  fs.mkdirSync(repo);
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(repo, 'source.mjs'), 'export default 1;\n');
  if (overrides) fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ budgets: overrides }));
  let args;
  if (isContinue) {
    // raw argv: OW-040 exercises --continue without a header grant; the helper requires a grant pair.
    const task = path.join(root, 'task.md');
    fs.writeFileSync(task, taskText);
    args = ['--agent', agent, '--repo', repo, '--order-id', 'phase-fixture', '--task-file', task,
      '--continue', '--phase', phase];
  } else {
    ({ argv: args } = orderInvocation({
      agent, order: { repository: repo, 'order id': 'phase-fixture',
        ...(agent === 'codex-build' ? { scope: 'source.mjs' } : {}),
        ...(phase === undefined ? {} : { phase }) },
      advice: agent === 'codex-build' ? 'mechanical' : undefined,
      questions: agent === 'codex-scout' ? ['What does the source export?'] : undefined,
      task: taskText ?? 'Inspect the fixture source.\n', dir: root,
    }));
  }
  const source = `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { AGENTS } from ${JSON.stringify(AGENTS)};
AGENTS[${JSON.stringify(agent)}].budget = ${JSON.stringify(budget)};
${launcherProcessMocks({ worker: refuse ? 'forbidden' : 'spawn', probe: refuse ? 'forbidden' : 'marker' })}
syncBuiltinESMExports();
const { runCodex } = await import(${JSON.stringify(RUNNER)});
process.exitCode = await runCodex(${JSON.stringify(args)});
`;
  const output = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: repo, input: '', encoding: 'utf8', timeout: 10_000, windowsHide: true,
    env: { ...process.env, CODEX_BRIDGE_HOME: home, CODEX_RUNS_ROOT: runs },
  });
  return { output, runs, repo };
}

function workerFrom(output) {
  assert.equal(output.status, 0, output.stderr || output.stdout || output.error?.message);
  const line = output.stdout.split(/\r?\n/).find((part) => part.startsWith('RUN='));
  assert.ok(line, output.stdout);
  const dir = line.slice(4).split(' order-id=', 1)[0];
  return {
    order: JSON.parse(fs.readFileSync(path.join(dir, 'worker.json'), 'utf8')),
    status: JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8')),
    env: JSON.parse(fs.readFileSync(path.join(dir, 'env.json'), 'utf8')),
  };
}

test('missing and undeclared phases refuse before probes and leave no run directory', () => {
  for (const [budget, phase, message] of [
    [{ scope: 5, advise: 15 }, undefined, /--phase is required.*scope, advise/],
    [{ default: 5, advise: 15 }, undefined, /--phase is required.*default, advise/],
    [{ scope: 5, advise: 15 }, 'typo', /undeclared --phase "typo".*scope, advise/],
    [{ scope: 5, advise: 15 }, 'default', /undeclared --phase "default"/],
    [15, 'scope', /undeclared --phase "scope".*default/],
    [15, 'constructor', /undeclared --phase "constructor"/],
    [15, '', /undeclared --phase ""/],
  ]) {
    const { output, runs, repo } = launch({ budget, phase, refuse: true });
    assert.equal(output.status, 2, output.stderr || output.error?.message);
    assert.match(output.stderr, message);
    assert.match(output.stderr, /The run folder was not created; quota was not spent/);
    assert.doesNotMatch(output.stdout, /RUN=|STARTED/);
    assert.equal(fs.existsSync(runs), false);
    assert.deepEqual(fs.readdirSync(repo), ['source.mjs']);
  }
});

test('single-phase agents keep the default phase when omitted or explicitly requested', () => {
  for (const agent of ['codex-scout', 'codex-build', 'codex-review']) {
    for (const phase of [undefined, 'default']) {
      const { order, status, env } = workerFrom(launch({ agent, phase }).output);
      assert.equal(order.phase, 'default');
      assert.equal(status.phase, 'default');
      assert.equal(order.budget_minutes, 15);
      assert.deepEqual(env.budgets[agent.slice('codex-'.length)], { default: 15 });
    }
  }
});

test('advisor scope continuation resolves its phase but refuses before probes and run creation', () => {
  // OW-040, 2026-09-30: a scope retry must not spend the continuation reserved for advise.
  const message = 'codex-advisor --phase scope refuses --continue: a scope pass is never continued, and continuing one ' +
    "spends the order's single continuation that its advise phase needs. Action: repeat the scope under a new order id " +
    "without --continue and without a continue: grant, then run advise as that order's continuation; a " +
    'scope run that failed is repeated with a `retry:` grant instead. The run folder was not created; quota was not spent.';
  assert.equal(resolveRunPhase({ agent: 'codex-advisor', phase: 'scope', continue: true },
    { advisor: { scope: 5, advise: 15 } }), 'scope');
  const { output, runs, repo } = launch({
    agent: 'codex-advisor', budget: { scope: 5, advise: 15 }, phase: 'scope', continue: true, refuse: true,
    taskText: '## Options\n- keep: Keep the boundary.\n- split: Split the boundary.\n## Paths\n- source.mjs\n',
  });
  assert.equal(output.status, 2, output.stderr || output.error?.message);
  assert.ok(output.stderr.includes(message), output.stderr);
  assert.doesNotMatch(output.stdout, /RUN=|STARTED/);
  // Plan_75 P3a: the moved OW-040 gate permits project scaffolding but must register no run.
  const entries = fs.existsSync(runs) ? fs.readdirSync(runs, { recursive: true }) : [];
  assert.equal(entries.some((entry) => /^\d{4}-\d{2}-\d{2}_\d{6}_/.test(path.basename(entry))), false);
  assert.equal(entries.some((entry) => ['status.json', 'worker.json'].includes(path.basename(entry))), false);
  assert.deepEqual(fs.readdirSync(repo).filter((entry) => entry !== 'runs'), ['source.mjs']);
});

test('advisor scope without continuation and advise with continuation still resolve', () => {
  const budgets = { advisor: { scope: 5, advise: 15 } };
  assert.equal(resolveRunPhase({ agent: 'codex-advisor', phase: 'scope', continue: false }, budgets), 'scope');
  assert.equal(resolveRunPhase({ agent: 'codex-advisor', phase: 'advise', continue: true }, budgets), 'advise');
});

test('a selected phase freezes its configured minutes in the worker order', () => {
  for (const [phase, minutes] of [['scope', 5], ['advise', 12]]) {
    const { order, status, env } = workerFrom(launch({
      budget: { scope: 5, advise: 15 }, phase, overrides: { scout: { advise: 12 } },
    }).output);
    assert.equal(order.phase, phase);
    assert.equal(status.phase, phase);
    assert.equal(order.budget_minutes, minutes);
    assert.equal(order.args.includes('--phase'), false);
    assert.deepEqual(env.budgets.scout, { scope: 5, advise: 12 });
  }
});

test('a numeric override for a multi-phase role fails loud before any run is registered', () => {
  // Accepting it would erase {scope, advise}; every run of the role would then be refused.
  const { output, runs } = launch({
    budget: { scope: 5, advise: 15 }, phase: 'scope', overrides: { scout: 9 }, refuse: true,
  });
  assert.notEqual(output.status, 0, output.stdout);
  assert.match(`${output.stdout}${output.stderr}`, /budgets\.scout.*must be a phase map/);
  assert.doesNotMatch(output.stdout, /RUN=|STARTED/);
  assert.equal(fs.existsSync(runs), false);
});

test('run-config prints phase minutes and preserves the single-phase budget line exactly', () => {
  for (const budget of [15, { scope: 5, advise: 15 }]) {
    const home = makeTempTree('phase-display-');
    const source = `
import { fileURLToPath } from 'node:url';
import { AGENTS } from ${JSON.stringify(AGENTS)};
AGENTS['codex-scout'].budget = ${JSON.stringify(budget)};
process.argv = [process.execPath, fileURLToPath(${JSON.stringify(CONFIG.href)})];
await import(${JSON.stringify(CONFIG.href)});
`;
    const output = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      encoding: 'utf8', windowsHide: true, env: { ...process.env, CODEX_BRIDGE_HOME: home },
    });
    assert.equal(output.status, 0, output.stderr);
    const expected = budget === 15
      ? 'budgets: scout: 15 minutes; build: 25 minutes; review: 20 minutes; advisor: scope: 10 minutes, advise: 25 minutes'
      : 'budgets: scout: scope: 5 minutes, advise: 15 minutes; build: 25 minutes; review: 20 minutes; advisor: scope: 10 minutes, advise: 25 minutes';
    assert.equal(output.stdout.split(/\r?\n/).find((line) => line.startsWith('budgets:')), expected);
  }
});
