/** Plan_80 E15/O2a freezes recovery policy before worker spawn. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { makeTempTree } from '../temp-tree.mjs';
import { launcherProcessMocks } from './launcher-mocks.mjs';
import { orderInvocation } from './order-invocation.mjs';
import { validScope } from '../meta/advisor-fixtures.mjs';

const LAUNCHER = new URL('../../src/home/lib/runner/launcher.mjs', import.meta.url).href;
const TASK = '## Options\n- keep: Keep the boundary.\n- split: Split the boundary.\n## Paths\n- source.mjs\n';
const BRAKE_KEY = 'CODEX_BRIDGE_AUTO_RECOVERY';

function fixture() {
  const root = makeTempTree('recovery-policy-launch-');
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  const codexHome = path.join(root, 'codex-home');
  for (const dir of [repo, home, codexHome]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(repo, 'source.mjs'), 'export default 1;\n');
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    models: {
      advisor: { model: randomUUID(), effort: 'high' },
      scout: { model: randomUUID(), effort: 'high' },
    },
  }));
  return { root, repo, home, codexHome, runs: path.join(repo, 'runs') };
}

function launch(tree, { agent = 'codex-advisor', phase = 'scope', grant, brake, changeBrake = false } = {}) {
  const { argv } = orderInvocation({
    agent, order: { repository: tree.repo, 'order id': 'recovery-policy-launch',
      ...(agent === 'codex-advisor' ? { phase } : {}) },
    grant, task: agent === 'codex-scout' ? '## Questions\n- What does source.mjs export?\n' : TASK, dir: tree.root,
  });
  const source = `
import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
${launcherProcessMocks({ worker: 'spawn', probe: 'marker' })}
const mockedSpawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  if (args.includes('--worker')) {
    const order = JSON.parse(fs.readFileSync(path.join(args[args.indexOf('--worker') + 1], 'worker.json'), 'utf8'));
    if (!order.recovery_policy?.watchdog) throw new Error('Recovery policy and watchdog must exist before worker spawn');
    if (${JSON.stringify(changeBrake)} && process.env.CODEX_BRIDGE_AUTO_RECOVERY !== 'off') {
      throw new Error('The fixture must change the host brake before the order is written');
    }
    const fields = Object.keys(order);
    if (fields[fields.indexOf('silence_policy') + 1] !== 'recovery_policy') {
      throw new Error('Recovery policy must follow silence policy');
    }
  }
  return mockedSpawn(command, args, options);
};
if (${JSON.stringify(changeBrake)}) {
  const mockedSpawnSync = childProcess.spawnSync;
  childProcess.spawnSync = (...args) => {
    process.env.CODEX_BRIDGE_AUTO_RECOVERY = 'off';
    return mockedSpawnSync(...args);
  };
}
if (${JSON.stringify(brake === 'maybe')}) {
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
    childProcess[name] = () => { throw new Error('Invalid brake must refuse before any subprocess'); };
  }
}
syncBuiltinESMExports();
const { launcher } = await import(${JSON.stringify(LAUNCHER)});
try { process.exitCode = await launcher(${JSON.stringify(argv)}); }
catch (error) {
  if (typeof error?.exitCode !== 'number') throw error;
  process.exitCode = error.exitCode;
}
`;
  const env = { ...process.env, CODEX_BRIDGE_HOME: tree.home, CODEX_RUNS_ROOT: tree.runs, CODEX_HOME: tree.codexHome };
  delete env[BRAKE_KEY];
  if (brake !== undefined) env[BRAKE_KEY] = brake;
  return spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: tree.repo, input: '', encoding: 'utf8', timeout: 10_000, windowsHide: true, env,
  });
}

function successfulRun(tree, options) {
  const output = launch(tree, options);
  assert.equal(output.status, 0, output.stderr || output.stdout || output.error?.message);
  const line = output.stdout.split(/\r?\n/).find((part) => part.startsWith('RUN='));
  assert.ok(line, output.stdout);
  const dir = line.slice(4).split(' order-id=')[0];
  const read = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  return { dir, worker: read('worker.json'), status: read('status.json') };
}

function adviseRun(tree, options = {}) {
  const scope = successfulRun(tree);
  fs.writeFileSync(path.join(scope.dir, 'status.json'), JSON.stringify({ ...scope.status, state: 'finished' }));
  fs.writeFileSync(path.join(scope.dir, 'meta.json'), JSON.stringify({
    agent: 'codex-advisor', phase: 'scope', status: 'OK',
  }));
  fs.writeFileSync(path.join(scope.dir, 'result.json'), JSON.stringify(validScope()));
  return successfulRun(tree, {
    ...options, phase: 'advise',
    grant: { kind: 'continue', run: path.basename(scope.dir), reason: 'settle the predicted risks' },
  });
}

test('advise launch freezes the measured recovery policy and default host brake', () => {
  const { worker } = adviseRun(fixture());
  const policy = worker.recovery_policy;
  assert.equal(policy.version, 1);
  assert.equal(policy.role, 'advisor');
  assert.equal(policy.phase, 'advise');
  assert.equal(policy.budget_ms, 1102000);
  assert.equal(policy.enabled, false);
  assert.equal(policy.calibration.id, 'plan80-s4-2026-10-15');
  assert.deepEqual(policy.brake, { key: BRAKE_KEY, value: 'on', source: 'default' });
  assert.deepEqual(policy.watchdog, {
    version: 1, arming: 'shadow', reason: 'stopping-retired', armed_switch: false,
  });
});

test('scout launch freezes an uncalibrated recovery budget', () => {
  const { worker } = successfulRun(fixture(), { agent: 'codex-scout', phase: 'default' });
  assert.deepEqual(worker.recovery_policy, {
    version: 1, role: 'scout', phase: 'default', budget_ms: null, enabled: false, calibration: null,
    brake: { key: BRAKE_KEY, value: 'on', source: 'default' },
    watchdog: { version: 1, arming: 'off', reason: 'no-threshold', armed_switch: false },
  });
});

test('launcher records an explicit off brake without changing the package switch', () => {
  const { worker } = adviseRun(fixture(), { brake: 'off' });
  assert.deepEqual(worker.recovery_policy.brake, { key: BRAKE_KEY, value: 'off', source: 'env' });
  assert.equal(worker.recovery_policy.enabled, false);
  assert.equal(worker.recovery_policy.budget_ms, 1102000);
  assert.deepEqual(worker.recovery_policy.watchdog, {
    version: 1, arming: 'off', reason: 'host-brake', armed_switch: false,
  });
});

test('launcher resolves the host brake once before subprocess preparation', () => {
  const { worker } = successfulRun(fixture(), { changeBrake: true });
  assert.deepEqual(worker.recovery_policy.brake, { key: BRAKE_KEY, value: 'on', source: 'default' });
});

test('invalid host brake refuses before any run folder is created', () => {
  const tree = fixture();
  const output = launch(tree, { brake: 'maybe' });
  assert.equal(output.error, undefined);
  assert.notEqual(output.status, 0);
  assert.match(output.stdout, /FAIL — [^\r\n]*CODEX_BRIDGE_AUTO_RECOVERY[^\r\n]*env[^\r\n]*"maybe"[^\r\n]*on or off\r?\nRun was not started; quota was not spent/);
  assert.equal(output.stdout.includes('RUN='), false);
  assert.equal(output.stdout.includes('STARTED'), false);
  assert.equal(fs.existsSync(tree.runs), false);
});
