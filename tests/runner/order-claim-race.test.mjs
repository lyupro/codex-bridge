/** Plan_60 D4/A4: reproduce the 2026-09-24 same-order double billing with real launchers. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import { kernelLockStrategy } from '../../src/home/lib/kernel-lock.mjs';
import { resolveProjectRunsDir } from '../../src/home/lib/runner/project-dir.mjs';
import { launcherProcessMocks } from './launcher-mocks.mjs';

const LAUNCHER = new URL('../../src/home/lib/runner/launcher.mjs', import.meta.url).href;
const TASK = 'advice: test-only\n\nProve the same-order launch claim without paid work.\n';
const REPLY = 'OK — race fixture';
const PROBE_DELAY_MS = 1500;
const startedLines = (output) => output.stdout.split(/\r?\n/).filter((line) => /^STARTED\b/.test(line));
const diagnostic = (output) => JSON.stringify(output);

function fixture(t) {
  const root = makeTempTree('order-claim-race-');
  const children = [];
  // Plan_60 D4: even a failed race must not leave a launcher holding the kernel claim or temp tree.
  t.after(async () => {
    for (const { child } of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    await Promise.all(children.map(({ done }) => done));
    await removeTempTree(root);
  });
  const repo = path.join(root, 'repo');
  const runsRoot = path.join(root, 'runs');
  fs.mkdirSync(repo);
  const project = resolveProjectRunsDir(runsRoot, repo).dir;
  return { repo, runsRoot, project, children };
}

function runFolders(project) {
  return fs.readdirSync(project, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => path.join(project, entry.name)).sort();
}

function launch(tree, orderId) {
  const args = [
    '--agent', 'codex-review', '--repo', tree.repo, '--slug', 'order-claim-race', '--order-id', orderId,
  ];
  const mocks = launcherProcessMocks({
    worker: 'spawn', probe: 'marker', workerPid: 'parent', probeDelayMs: PROBE_DELAY_MS,
  });
  const script = `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
${mocks}
syncBuiltinESMExports();
const { launcher } = await import(${JSON.stringify(LAUNCHER)});
// Plan_60 D4/A4: release both imported launchers together so startup speed cannot serialize the fixture.
const start = new Promise((resolve) => process.once('message', resolve));
process.send('ready');
await start;
process.disconnect();
// Plan_58 acceptance, 2026-09-20: preserve run-codex's refusal exit codes in a child-script harness.
try {
  const exitCode = await launcher(${JSON.stringify(args)});
  if (exitCode !== undefined) process.exitCode = exitCode;
} catch (error) {
  if (typeof error?.exitCode !== 'number') throw error;
  process.exitCode = error.exitCode;
}
`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: tree.repo,
    env: { ...process.env, CODEX_RUNS_ROOT: tree.runsRoot },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  const output = { stdout: '', stderr: '', code: null, signal: null, error: null };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output.stdout += chunk; });
  child.stderr.on('data', (chunk) => { output.stderr += chunk; });
  child.stdin.on('error', (error) => { output.error = error.message; });
  const ready = new Promise((resolve, reject) => {
    child.once('message', (message) => {
      if (message === 'ready') resolve();
      else reject(new Error('Unexpected launcher readiness message: ' + message));
    });
    child.once('error', reject);
    child.once('close', () => reject(new Error('Launcher exited before readiness: ' + diagnostic(output))));
  });
  const done = new Promise((resolve) => {
    child.once('error', (error) => { output.error = error.message; });
    child.once('close', (code, signal) => {
      output.code = code;
      output.signal = signal;
      resolve(output);
    });
  });
  const handle = { child, output, ready, done };
  tree.children.push(handle);
  child.stdin.end(TASK);
  return handle;
}

async function launchTogether(tree, orders) {
  const children = orders.map((order) => launch(tree, order));
  await Promise.all(children.map(({ ready }) => ready));
  for (const { child } of children) child.send('start');
  return children;
}

function assertStarted(output) {
  assert.equal(output.error, null, diagnostic(output));
  assert.equal(output.signal, null, diagnostic(output));
  assert.equal(output.code, 0, diagnostic(output));
  assert.equal(startedLines(output).length, 1, diagnostic(output));
}

const raceOptions = {
  timeout: 60_000,
  skip: kernelLockStrategy() === null ? 'This platform has no per-order kernel lock strategy.' : false,
};

test('two simultaneous launchers of one order start one worker and attach to its reply', raceOptions, async (t) => {
  const tree = fixture(t);
  const orderId = 'same-order-race';
  const children = await launchTogether(tree, [orderId, orderId]);
  const winner = await Promise.race(children.map(async (child) => ({ child, output: await child.done })));
  assertStarted(winner.output);
  assert.equal(children.flatMap(({ output }) => startedLines(output)).length, 1);
  const folders = runFolders(tree.project);
  assert.equal(folders.length, 1);
  const runDir = folders[0];
  assert.ok(winner.output.stdout.includes(`RUN=${runDir} order-id=${orderId}`), diagnostic(winner.output));
  const registered = JSON.parse(fs.readFileSync(path.join(runDir, 'status.json'), 'utf8'));
  assert.equal(registered.pid, process.pid);
  assert.equal(registered.order_id, orderId);
  assert.equal(registered.sandbox_probe.outcome, 'alive');
  assert.ok(registered.sandbox_probe.attempts[0].ms >= PROBE_DELAY_MS - 100);

  // Plan_60 D4: publish the answer last, as the worker does, while the contender sees a live pid.
  fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify({
    status: 'OK', exit: 0, agent: 'codex-review', session_id: 'race-fixture',
    events_bytes: 0, stderr_bytes: 0, tokens_reported: false,
  }) + '\n');
  fs.writeFileSync(path.join(runDir, 'reply.txt'), REPLY + '\n');
  const contender = children.find((child) => child !== winner.child);
  const attached = await contender.done;
  assert.equal(attached.error, null, diagnostic(attached));
  assert.equal(attached.signal, null, diagnostic(attached));
  assert.equal(attached.code, 0, diagnostic(attached));
  assert.ok(attached.stdout.includes(`ATTACH=${runDir} order-id=${orderId}`), diagnostic(attached));
  assert.ok(attached.stdout.includes(REPLY), diagnostic(attached));
  assert.equal(startedLines(attached).length, 0, diagnostic(attached));
  assert.equal(children.flatMap(({ output }) => startedLines(output)).length, 1);
  assert.deepEqual(runFolders(tree.project), [runDir]);
});

test('two simultaneous different orders in one project each start a worker', raceOptions, async (t) => {
  const tree = fixture(t);
  const orders = ['first-order-race', 'second-order-race'];
  const children = await launchTogether(tree, orders);
  const outputs = await Promise.all(children.map(({ done }) => done));
  for (const output of outputs) {
    assertStarted(output);
    assert.doesNotMatch(output.stdout, /^ATTACH=/m);
  }
  assert.equal(outputs.flatMap(startedLines).length, 2);
  const folders = runFolders(tree.project);
  assert.equal(folders.length, 2);
  const statuses = folders.map((dir) => JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8')));
  assert.deepEqual(statuses.map((status) => status.order_id).sort(), orders.slice().sort());
  for (const status of statuses) assert.equal(status.pid, process.pid);
  for (const [index, output] of outputs.entries()) {
    const runDir = folders.find((dir, folderIndex) => statuses[folderIndex].order_id === orders[index]);
    assert.ok(output.stdout.includes(`RUN=${runDir} order-id=${orders[index]}`), diagnostic(output));
  }
});

test('launcher mocks reject unknown worker pid and probe delay options', () => {
  const base = { worker: 'spawn', probe: 'marker' };
  for (const workerPid of [null, 1, '999999', 'child', false]) {
    assert.throws(() => launcherProcessMocks({ ...base, workerPid }), TypeError);
  }
  for (const probeDelayMs of [null, -1, 1.5, '1500', false, NaN, Infinity, 2147483648]) {
    assert.throws(() => launcherProcessMocks({ ...base, probeDelayMs }), TypeError);
  }
});

test('launcher mocks retain defaults and delay sandbox probes on both spawn routes', () => {
  const cases = [{}, { workerPid: 'parent', probeDelayMs: 150 }];
  for (const options of cases) {
    const source = `
import childProcess from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
${launcherProcessMocks({ worker: 'spawn', probe: 'marker', ...options })}
const delay = ${options.probeDelayMs ?? 0};
const worker = childProcess.spawn(process.execPath, ['--worker', 'fixture']);
assert.equal(worker.pid, ${options.workerPid === 'parent' ? 'process.ppid' : '999999'});
await once(worker, 'spawn');
const syncStart = performance.now();
const syncProbe = childProcess.spawnSync('codex', ['sandbox']);
assert.equal(syncProbe.stdout, 'codex-bridge-sandbox-ok');
assert.ok(performance.now() - syncStart >= delay - 20);
const asyncStart = performance.now();
const asyncProbe = childProcess.spawn('codex', ['sandbox']);
let marker = '';
asyncProbe.stdout.on('data', (chunk) => { marker += chunk; });
await once(asyncProbe, 'close');
assert.equal(marker, 'codex-bridge-sandbox-ok\\n');
assert.ok(performance.now() - asyncStart >= delay - 20);
`;
    const output = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      encoding: 'utf8', timeout: 10_000, windowsHide: true,
    });
    assert.equal(output.error, undefined, output.error?.message);
    assert.equal(output.status, 0, output.stderr);
  }
});
