/** Verifies dispatcher imports and its public help, version, doctor, and error exits. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main } from '../../bin/codex-bridge.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import { makeHomeImage } from '../home-image.mjs';
import { orderInvocation } from '../runner/order-invocation.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const BIN = path.join(ROOT, 'bin', 'codex-bridge.mjs');

function run(args, env = {}) {
  // raw argv: Node transports dispatcher arguments; orders live in the task file (Plan_63 D8).
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...env },
  });
}

test('importing dispatcher does not execute main', () => {
  assert.equal(typeof main, 'function');
});

test('--help and -h print the command list', () => {
  for (const flag of ['--help', '-h']) {
    // raw argv: public dispatcher help aliases are the subject of this test.
    const result = run([flag]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Commands:[\s\S]*install[\s\S]*update[\s\S]*uninstall[\s\S]*doctor[\s\S]*unlock/);
    assert.match(result.stdout, /codex-bridge run <runner options> --task-file <path>/);
    assert.match(result.stdout, /codex-bridge hook <name>/);
  }
});

test('run forwards runner arguments and returns the runner exit code unchanged', async (t) => {
  const root = makeTempTree('bridge-bin-run-');
  t.after(() => removeTempTree(root));
  const home = await makeHomeImage(t);
  const { argv } = orderInvocation({
    agent: 'codex-review', order: { repository: root, 'order id': 'bin-run' },
    task: 'check current state', dir: root,
  });
  // raw argv: run and --no-wait wrap the helper transport invocation (Plan_63 D8).
  const result = run(
    ['run', ...argv, '--no-wait'],
    { CODEX_RUNS_ROOT: path.join(root, 'runs'), CODEX_BRIDGE_HOME: home },
  );
  assert.equal(result.status, 4, result.stderr);
  assert.match(result.stdout, /--no-wait never starts a new run/);
  assert.doesNotMatch(result.stderr, /unknown run option/);
});

test('run forwards header phase and an undeclared phase leaves no run directory', async (t) => {
  const home = await makeHomeImage(t);
  const root = makeTempTree('bridge-bin-phase-');
  t.after(() => removeTempTree(root));
  const runs = path.join(root, 'runs');
  // raw argv: dispatcher transport wraps the header-backed order (Plan_63 D8).
  const args = (phase, agent) => ['run', ...orderInvocation({
    agent, order: { repository: root, 'order id': 'bin-phase', ...(phase === undefined ? {} : { phase }) },
    task: agent === 'codex-advisor'
      ? 'Compare boundaries.\n\n## Options\n- keep: Keep the boundary.\n- split: Split the boundary.\n\n## Paths\n- task.md\n'
      : 'check current state', dir: root,
  }).argv, '--no-wait'];
  const env = { CODEX_RUNS_ROOT: runs, CODEX_BRIDGE_HOME: home };
  const invalid = run(args('undeclared', 'codex-advisor'), env);
  assert.equal(invalid.status, 2, invalid.stderr);
  assert.match(invalid.stderr, /undeclared `phase:` "undeclared".*allowed phases: scope, advise/);
  assert.match(invalid.stderr, /The run folder was not created; quota was not spent/);
  assert.equal((await fs.readdir(root)).includes('runs'), false);
  const declared = run(args('scope', 'codex-advisor'), env);
  assert.equal(declared.status, 4, declared.stderr);
  assert.match(declared.stdout, /--no-wait never starts a new run/);
  // Plan_63 D8: single-phase agents use their implicit phase, with no phase header label.
  const valid = run(args(undefined, 'codex-review'), env);
  assert.equal(valid.status, 4, valid.stderr);
  assert.match(valid.stdout, /--no-wait never starts a new run/);
});

test('--version and -v print package.json version', async () => {
  const { version } = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  for (const flag of ['--version', '-v']) {
    // raw argv: public dispatcher version aliases are the subject of this test.
    const result = run([flag]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), version);
  }
});

test('unknown command exits 2 with a useful error', () => {
  // raw argv: an unknown dispatcher command must refuse before any order exists.
  const result = run(['unknown']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown command "unknown"/);
  assert.match(result.stderr, /--help/);
});

test('the old sweep command refuses with the unlock rename', () => {
  // raw argv: the retired dispatcher command must report its replacement.
  const result = run(['sweep']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /sweep was renamed to codex-bridge unlock/);
  assert.match(result.stderr, /use the new command/);
});

test('shared option parser rejects flags outside each command contract', () => {
  // raw argv: doctor must refuse options outside its own command contract.
  const doctor = run(['doctor', '--dry-run']);
  assert.equal(doctor.status, 2);
  assert.match(doctor.stderr, /unknown doctor option/);
  // raw argv: uninstall must refuse options outside its own command contract.
  const uninstall = run(['uninstall', '--force']);
  assert.equal(uninstall.status, 2);
  assert.match(uninstall.stderr, /unknown uninstall option/);
  // raw argv: update must refuse options outside its own command contract.
  const update = run(['update', '--unknown']);
  assert.equal(update.status, 2);
  assert.match(update.stderr, /unknown update option/);
});

test('update flags reach the command handler', (t) => {
  const host = makeTempTree('bridge-bin-update-');
  t.after(() => removeTempTree(host));
  // raw argv: update installation flags, including its own --scope, remain dispatcher inputs.
  const result = run(
    ['update', '--host', host, '--scope', 'project', '--dry-run', '--force'],
    { CODEX_HOME: path.join(host, 'codex-home'), CODEX_BRIDGE_HOME: path.join(host, 'brand') },
  );
  assert.equal(result.status, 1);
  assert.match(result.stdout, /not installed/);
  assert.doesNotMatch(result.stderr, /unknown update option/);
});

test('doctor subcommand diagnoses only the explicit temporary host', (t) => {
  const host = makeTempTree('bridge-bin-doctor-');
  t.after(() => removeTempTree(host));
  // raw argv: doctor diagnoses only the explicit temporary installation host.
  const result = run(
    ['doctor', '--host', host],
    { CODEX_HOME: path.join(host, 'codex-home'), CODEX_BRIDGE_HOME: path.join(host, 'brand') },
  );
  assert.equal(result.status, 1);
  assert.match(result.stdout, /installation: not installed/);
  assert.match(result.stdout, new RegExp(host.replaceAll('\\', '\\\\')));
});
