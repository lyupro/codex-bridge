/** Plan_57: the 2026-09-16 broken sandbox must refuse before a run can spend quota. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import { resolveProjectRunsDir } from '../../src/home/lib/runner/project-dir.mjs';
import { SANDBOX_PROBE_MARKER } from '../../src/home/lib/runner/sandbox-probe.mjs';

const RUN_CODEX = fileURLToPath(new URL('../../src/home/lib/run-codex.mjs', import.meta.url));
const LAUNCHER = new URL('../../src/home/lib/runner/launcher.mjs', import.meta.url).href;
const SANDBOX_FAILURE = 'windows sandbox failed: helper_unknown_error: apply deny-read ACLs';
const WINDOWS_ONLY = 'The fake codex.cmd reaches the probe through cmd.exe; the Linux form is covered in sandbox-probe.test.mjs.';

function fixture(t, scenario) {
  const root = makeTempTree(`sandbox-gate-${scenario}-`);
  t.after(() => removeTempTree(root));
  const repo = path.join(root, 'repo');
  const runsRoot = path.join(root, 'runs');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'existing.mjs'), 'export default 1;\n');
  return { root, repo, runsRoot };
}

function installFakeCodex(root, scenario) {
  const bin = path.join(root, 'bin');
  const script = path.join(root, 'fake-codex.mjs');
  fs.mkdirSync(bin);
  fs.writeFileSync(script, `
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(new URL('./codex-calls.jsonl', import.meta.url), JSON.stringify(args) + '\\n');
if (args[0] === '--version') {
  console.log('codex-cli 0.154.0');
} else if (args[0] === 'sandbox') {
  const scenario = ${JSON.stringify(scenario)};
  if (scenario === 'dead') {
    console.error(${JSON.stringify(SANDBOX_FAILURE)});
    process.exitCode = 1;
  } else if (scenario === 'changed-flags' && args.includes('-c')) {
    process.exitCode = 1;
  } else {
    console.log(${JSON.stringify(SANDBOX_PROBE_MARKER)});
  }
} else {
  console.error('Unexpected fake Codex invocation: ' + JSON.stringify(args));
  process.exitCode = 90;
}
`);
  // Like deadline.test.mjs, a real cmd.exe resolves this shim and invokes only the fixture.
  fs.writeFileSync(path.join(bin, 'codex.cmd'), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  return bin;
}

function fakeEnv(tree, scenario) {
  const bin = installFakeCodex(tree.root, scenario);
  // Windows env keys are case-insensitive: retain exactly one PATH so the shim wins resolution.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH'));
  return { ...env, PATH: [bin, process.env.PATH].filter(Boolean).join(path.delimiter), CODEX_RUNS_ROOT: tree.runsRoot };
}

function calls(root) {
  const log = path.join(root, 'codex-calls.jsonl');
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split(/\r?\n/).map(JSON.parse) : [];
}

function baseArgs(agent, repo) {
  return [
    '--agent', agent, '--repo', repo, '--slug', 'sandbox-gate', '--order-id', 'sandbox-gate-order',
    ...(agent === 'codex-build' ? ['--scope', 'src/existing.mjs'] : []),
    ...(agent === 'codex-scout' ? ['--question', 'What does the existing module export?'] : []),
  ];
}

function runner(args, env, cwd) {
  return spawnSync(process.execPath, [RUN_CODEX, ...args], {
    cwd, env, input: 'sandbox gate fixture', encoding: 'utf8', timeout: 20_000, windowsHide: true,
  });
}

const WORKER_SOURCE = `
import { EventEmitter } from 'node:events';
childProcess.spawn = () => {
  const worker = new EventEmitter();
  worker.pid = 999999;
  worker.unref = () => {};
  queueMicrotask(() => worker.emit('spawn'));
  return worker;
};
`;

function mockedLauncher(source, args, env, cwd) {
  const script = `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
${source}
syncBuiltinESMExports();
const { launcher } = await import(${JSON.stringify(LAUNCHER)});
const exitCode = await launcher(${JSON.stringify(args)});
if (exitCode !== undefined) process.exitCode = exitCode;
`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd, env, input: 'sandbox gate fixture', encoding: 'utf8', timeout: 20_000, windowsHide: true,
  });
}

function runStatus(output) {
  const line = output.stdout.split(/\r?\n/).find((part) => part.startsWith('RUN='));
  assert.ok(line, `launcher did not print a run path:\n${output.stdout}\n${output.stderr}`);
  const runDir = line.slice(4).split(' order-id=', 1)[0];
  return JSON.parse(fs.readFileSync(path.join(runDir, 'status.json'), 'utf8'));
}

function statusFiles(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? statusFiles(file) : entry.name === 'status.json' ? [file] : [];
  });
}

function assertSilentProbe(output) {
  assert.doesNotMatch(`${output.stdout}\n${output.stderr}`, /codex-bridge-sandbox-ok|sandbox probe|sandbox flags/i);
  assert.equal(output.stderr, '');
}

test('a dead sandbox refuses the real CLI before creating a run or checking Codex again', (t) => {
  if (process.platform !== 'win32') return t.skip(WINDOWS_ONLY);
  const tree = fixture(t, 'dead');
  const output = runner(baseArgs('codex-review', tree.repo), fakeEnv(tree, 'dead'), tree.repo);

  assert.equal(output.status, 2, `${output.stdout}\n${output.stderr}`);
  assert.match(output.stderr, /The Codex sandbox on this host cannot start a process/);
  assert.match(output.stderr, /The run folder was not created; quota was not spent\./);
  assert.ok(output.stderr.includes(SANDBOX_FAILURE));
  assert.equal(output.stdout, '');
  assert.deepEqual(statusFiles(tree.runsRoot), []);
  const invocations = calls(tree.root);
  assert.equal(invocations.some((args) => args.includes('exec')), false);
  assert.deepEqual(invocations.map((args) => args[0]), ['sandbox', 'sandbox', '--version']);
  assert.ok(invocations[0].includes('-c'));
  assert.deepEqual(invocations[1], ['sandbox', '--', 'cmd', '/d', '/c', 'echo', SANDBOX_PROBE_MARKER]);
});

test('changed Codex flags continue silently and record both real probe attempts', (t) => {
  if (process.platform !== 'win32') return t.skip(WINDOWS_ONLY);
  const tree = fixture(t, 'changed-flags');
  const output = mockedLauncher(WORKER_SOURCE, baseArgs('codex-review', tree.repo), fakeEnv(tree, 'changed-flags'), tree.repo);

  assert.equal(output.status, 0, `${output.stdout}\n${output.stderr}`);
  const probe = runStatus(output).sandbox_probe;
  assert.equal(probe.outcome, 'inconclusive');
  assert.match(probe.reason, /no longer accepts.*sandbox flags/);
  assert.deepEqual(probe.attempts.map(({ form, status, marker }) => ({ form, status, marker })), [
    { form: 'flagged', status: 1, marker: false },
    { form: 'control', status: 0, marker: true },
  ]);
  for (const attempt of probe.attempts) {
    assert.ok(Number.isInteger(attempt.ms) && attempt.ms >= 0);
    assert.equal(attempt.stderrTail, '');
  }
  const invocations = calls(tree.root);
  assert.deepEqual(invocations.map((args) => args[0]), ['sandbox', 'sandbox', '--version']);
  assert.ok(invocations[0].includes('-c'));
  assert.deepEqual(invocations[1], ['sandbox', '--', 'cmd', '/d', '/c', 'echo', SANDBOX_PROBE_MARKER]);
  assertSilentProbe(output);
});

for (const [agent, sandbox] of [['codex-build', 'workspace-write'], ['codex-scout', 'read-only']]) {
  test(`a live sandbox records one attempt using ${agent}'s permission profile`, (t) => {
    if (process.platform !== 'win32') return t.skip(WINDOWS_ONLY);
    const tree = fixture(t, agent);
    const output = mockedLauncher(WORKER_SOURCE, baseArgs(agent, tree.repo), fakeEnv(tree, 'alive'), tree.repo);

    assert.equal(output.status, 0, `${output.stdout}\n${output.stderr}`);
    const probe = runStatus(output).sandbox_probe;
    assert.equal(probe.outcome, 'alive');
    assert.equal(probe.reason, 'The Codex sandbox started a process.');
    assert.equal(probe.attempts.length, 1);
    assert.deepEqual(Object.keys(probe).sort(), ['attempts', 'outcome', 'reason']);
    const attempt = probe.attempts[0];
    assert.equal(attempt.form, 'flagged');
    assert.equal(attempt.status, 0);
    assert.equal(attempt.marker, true);
    assert.equal(attempt.stderrTail, '');
    assert.ok(Number.isInteger(attempt.ms) && attempt.ms >= 0);
    const invocations = calls(tree.root);
    assert.deepEqual(invocations.map((args) => args[0]), ['sandbox', '--version']);
    const flagged = invocations[0];
    assert.ok(flagged.includes('-c'));
    assert.ok(flagged.includes(`sandbox_mode=${sandbox}`), JSON.stringify(flagged));
    assert.ok(flagged.includes('windows.sandbox=elevated'), JSON.stringify(flagged));
    assert.deepEqual(flagged.slice(flagged.indexOf('--')), ['--', 'cmd', '/d', '/c', 'echo', SANDBOX_PROBE_MARKER]);
    assertSilentProbe(output);
  });
}

test('a busy writing tree refuses without probing or recording sandbox_probe', async (t) => {
  if (process.platform !== 'win32') return t.skip(WINDOWS_ONLY);
  const tree = fixture(t, 'busy');
  const env = fakeEnv(tree, 'dead');
  const project = resolveProjectRunsDir(tree.runsRoot, tree.repo).dir;
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  const holderExited = once(holder, 'exit');
  try {
    await once(holder, 'spawn');
    fs.mkdirSync(path.join(project, 'other-live-run'));
    fs.writeFileSync(path.join(project, 'other-live-run', 'status.json'), JSON.stringify({
      state: 'running', pid: holder.pid, agent: 'codex-build', repo: tree.repo,
      slug: 'other-task', task_hash: 'other-hash', order_id: 'other-order', started_at: new Date().toISOString(),
    }));
    const output = runner(baseArgs('codex-build', tree.repo), env, tree.repo);

    assert.equal(output.status, 1, `${output.stdout}\n${output.stderr}`);
    const status = runStatus(output);
    assert.equal(status.state, 'aborted_pre_start');
    assert.equal(Object.hasOwn(status, 'sandbox_probe'), false);
    assert.match(output.stdout, /already active for this repository/);
    assert.deepEqual(calls(tree.root), []);
  } finally {
    holder.kill();
    await holderExited;
  }
});

test('an unsupported platform records the entire skipped result', (t) => {
  const tree = fixture(t, 'skipped');
  const source = `
Object.defineProperty(process, 'platform', { value: 'darwin' });
const realSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = (command, args, options) => {
  if (args.includes('sandbox')) throw new Error('A skipped probe must not spawn Codex');
  return command === 'git' ? realSpawnSync(command, args, options) : { status: 0, stdout: '', stderr: '', error: null };
};
${WORKER_SOURCE}
`;
  const output = mockedLauncher(source, baseArgs('codex-review', tree.repo), {
    ...process.env, CODEX_RUNS_ROOT: tree.runsRoot,
  }, tree.repo);

  assert.equal(output.status, 0, `${output.stdout}\n${output.stderr}`);
  assert.deepEqual(runStatus(output).sandbox_probe, { outcome: 'skipped' });
  assertSilentProbe(output);
});
