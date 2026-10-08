/** Keeps the dispatcher's commands, its help text, and the README command block in sync. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CLI_NAMES } from '../../src/home/lib/cli-names.mjs';
import { commandOptions, HELP, main } from '../../bin/codex-bridge.mjs';
import { COMMANDS } from '../../cli/command-registry.mjs';
import { renderCommandHelp } from '../../cli/command-help.mjs';
import { withOwner } from '../../cli/install-owners.mjs';
import { withTempTree } from '../temp-tree.mjs';

test('doctor accepts a probe executable and other commands reject it', () => {
  assert.deepEqual(commandOptions('doctor', ['--probe-contract', '--probe-executable', 'x.exe']),
    { probeContract: true, probeExecutable: 'x.exe' });
  assert.throws(() => commandOptions('install', ['--probe-executable', 'x.exe']), /unknown install option/);
});

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const BIN = path.join(ROOT, 'bin', 'codex-bridge.mjs');

function unique(commands) {
  return [...new Set(commands)];
}

function helpCommands(help) {
  const block = help.match(/\nCommands:\n([\s\S]*?)(?:\n\n|$)/);
  assert.ok(block, 'The --help output must contain a Commands block.');
  return [...block[1].matchAll(/^[ \t]{2}([a-z][\w-]*)[ \t]+/gm)]
    .map(([, command]) => command);
}

function installBlock(readme) {
  const block = readme.match(/## Install[\s\S]*?```[^\r\n]*\r?\n([\s\S]*?)\r?\n```/);
  assert.ok(block, 'README.md must contain an install command block.');
  return block[1];
}

// The command list is read from the reference table, not from the install block. Until Plan_33 it
// came from the install block, and the only way to keep this test green was to list uninstall,
// prune and stop under "Install" — a README shaped for its own test rather than for the person
// installing the package. The install block is still asserted to exist: a package whose first
// screen has no install command is the audit's P-01 failure.
function readmeCommands(readme) {
  installBlock(readme);
  const table = readme.match(/## Command reference\r?\n([\s\S]*?)(?:\r?\n## |$)/);
  assert.ok(table, 'README.md must contain a Command reference table.');
  return unique([...table[1].matchAll(/^\|\s*`([a-z][\w-]*)/gm)].map(([, command]) => command));
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readmeBinaries(readme) {
  const block = installBlock(readme);
  return unique(CLI_NAMES.filter((name) =>
    new RegExp(`^${escapeRegex(name)}\\s+[a-z][\\w-]*`, 'm').test(block)));
}

function sorted(commands) {
  return [...commands].sort();
}

test('dispatcher, --help, and README expose the same command list', async () => {
  const readme = await fs.readFile(path.join(ROOT, 'README.md'), 'utf8');
  const result = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);

  const expected = sorted(COMMANDS.filter((entry) => entry.section === 'public').map((entry) => entry.name));
  assert.deepEqual(sorted(helpCommands(result.stdout)), expected, '--help command list is stale.');
  assert.deepEqual(sorted(readmeCommands(readme)), expected, 'README.md command list is stale.');
});

test('package.json, --help, and README expose the same binary names', async () => {
  const [packageSource, readme] = await Promise.all([
    fs.readFile(path.join(ROOT, 'package.json'), 'utf8'),
    fs.readFile(path.join(ROOT, 'README.md'), 'utf8'),
  ]);
  const packageJson = JSON.parse(packageSource);
  const packageNames = Object.keys(packageJson.bin);
  assert.deepEqual(sorted(packageNames), sorted(CLI_NAMES), 'package.json#bin names are stale.');
  // No leading "./": npm 11 publish rewrites it and logs the entry as "invalid and removed" (0.6.6).
  assert.ok(
    packageNames.every((name) => packageJson.bin[name] === 'bin/codex-bridge.mjs'),
    'Every binary name must point to the dispatcher entry point, spelled the way npm publishes it.',
  );

  const result = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  for (const name of packageNames) {
    assert.match(result.stdout, new RegExp(`^  ${escapeRegex(name)}\\s`, 'm'),
      `--help does not mention ${name}.`);
  }
  assert.deepEqual(sorted(readmeBinaries(readme)), sorted(packageNames),
    'README.md binary names are stale.');
});

function captureIO() {
  const output = [];
  const errors = [];
  return { output, errors, log: (message) => output.push(message), error: (message) => errors.push(message) };
}

// raw argv: `--scope` here is the install scope of the command line under test, not an order flag.
test('inventory confirm --dry-run reaches the confirmation handler', async (t) => {
  const hostRoot = path.join(ROOT, 'inventory-test-host');
  const record = withOwner(null, { root: hostRoot, scope: 'project' }, {
    name: '@lyupro/codex-bridge', version: '0.1.0', installedAt: '2026-10-07T00:00:00.000Z',
    mode: 'copy',
    files: [{ root: 'claude', path: 'agents/codex-bridge/dispatcher.md' }, { root: 'brand', path: 'hooks/reply-guard.mjs' }],
    fingerprints: {
      claude: { 'agents/codex-bridge/dispatcher.md': 'a'.repeat(64) },
      brand: { 'hooks/reply-guard.mjs': 'b'.repeat(64) },
    },
    hooks: [{ event: 'SubagentStop', root: 'brand', path: 'hooks/reply-guard.mjs', command: 'codex-bridge hook reply-guard' }],
  });
  t.mock.method(fs, 'readFile', async (file) => {
    if (path.basename(file) === '.installed.json') return JSON.stringify(record);
    throw Object.assign(new Error('missing test registry'), { code: 'ENOENT' });
  });
  const io = captureIO();
  assert.equal(await main(['inventory', 'confirm', '--scope', 'project', '--host', hostRoot, '--dry-run'], io), 0);
  assert.match(io.output[0], /Recorded hosts:/);
  assert.ok(io.output[0].includes(hostRoot));
  assert.match(io.output[0], /Dry run: nothing changed\./);
  assert.deepEqual(io.errors, []);
  assert.deepEqual(commandOptions('inventory', ['--dry-run']), { dryRun: true });
});

test('inventory requires confirm and rejects unknown flags', async () => {
  for (const argv of [['inventory'], ['inventory', 'unknown'], ['inventory', '--dry-run']]) {
    await assert.rejects(main(argv, captureIO()), /unknown inventory action/);
  }
  await assert.rejects(main(['inventory', 'confirm', '--unknown'], captureIO()), /unknown inventory option/);
});

// raw argv: the help text spells the install `--scope` flag.
test('help lists the public inventory confirmation command', async () => {
  const io = captureIO();
  assert.equal(await main(['--help'], io), 0);
  assert.ok(helpCommands(io.output[0]).includes('inventory'));
  assert.ok(io.output[0].includes('codex-bridge inventory confirm [--scope user|project] [--host <path>] [--dry-run]'));
});

test('runs move --dry-run reaches the copy preflight and leaves the store unchanged', async (t) => {
  await withTempTree('runs-move-dispatch-', async (homedir) => {
    const legacyRoot = path.join(homedir, '.claude', 'codex-runs');
    await fs.mkdir(path.join(legacyRoot, 'project', 'empty'), { recursive: true });
    await fs.writeFile(path.join(legacyRoot, 'reply.txt'), 'reply');
    t.mock.method(os, 'homedir', () => homedir);
    // Plan_77 D7: an isolated legacy root must remain active until a later move record.
    for (const key of ['CODEX_RUNS_ROOT', 'CODEX_BRIDGE_HOME']) {
      const old = process.env[key];
      delete process.env[key];
      t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
    }
    const io = captureIO();
    assert.equal(await main(['runs', 'move', '--dry-run'], io), 0);
    assert.match(io.output[0], /^Would copy 1 files \(0\.00 MB\) in 2 folders from /);
    assert.ok(io.output[0].includes(legacyRoot));
    assert.match(io.output[0], /Dry run: nothing changed\./);
    assert.equal(io.output.length, 1);
    assert.deepEqual(io.errors, []);
    assert.deepEqual(commandOptions('runs', ['--dry-run']), { dryRun: true });
    assert.equal(await fs.readFile(path.join(legacyRoot, 'reply.txt'), 'utf8'), 'reply');
    assert.deepEqual(await fs.readdir(homedir), ['.claude']);
  });
});

// D3/B5c: piped input cannot consent to deleting records after the D7 switch.
test('runs move with non-interactive stdin reports the old folder after the move and on retry', async (t) => {
  await withTempTree('runs-move-dispatch-real-', async (homedir) => {
    const legacyRoot = path.join(homedir, '.claude', 'codex-runs');
    const home = path.join(homedir, 'home');
    const homeRoot = path.join(home, 'runs');
    await fs.mkdir(path.join(legacyRoot, 'project', 'empty'), { recursive: true });
    await fs.writeFile(path.join(legacyRoot, 'reply.txt'), 'reply');
    t.mock.method(os, 'homedir', () => homedir);
    for (const key of ['CODEX_RUNS_ROOT', 'CODEX_BRIDGE_HOME']) {
      const old = process.env[key];
      delete process.env[key];
      t.after(() => { if (old === undefined) delete process.env[key]; else process.env[key] = old; });
    }
    process.env.CODEX_BRIDGE_HOME = home;
    const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    t.after(() => { if (tty) Object.defineProperty(process.stdin, 'isTTY', tty); else delete process.stdin.isTTY; });
    const hint = `The old folder ${legacyRoot} is still there; run codex-bridge runs move in a terminal to remove it.`;
    for (const repeated of [false, true]) {
      const io = captureIO();
      assert.equal(await main(['runs', 'move'], io), 0);
      assert.equal(io.output.length, 2);
      assert.match(io.output[0], repeated ? /^Run records already live in / : /^Moved 1 files /);
      assert.equal(io.output[1], hint);
      assert.deepEqual(io.errors, []);
      assert.equal(await fs.readFile(path.join(legacyRoot, 'reply.txt'), 'utf8'), 'reply');
      assert.equal(await fs.readFile(path.join(homeRoot, 'reply.txt'), 'utf8'), 'reply');
    }
    await fs.writeFile(path.join(legacyRoot, 'late-run'), 'written by an older package');
    const io = captureIO();
    assert.equal(await main(['runs', 'move'], io), 1);
    assert.match(io.output[1], /has 1 entries the new store does not hold identically:/);
    assert.match(io.output[1], /late-run\nNothing was removed\./);
    assert.equal(await fs.readFile(path.join(legacyRoot, 'late-run'), 'utf8'), 'written by an older package');
  });
});

test('runs requires move and accepts only --dry-run', async () => {
  for (const argv of [['runs'], ['runs', 'unknown'], ['runs', '--dry-run']]) {
    await assert.rejects(main(argv, captureIO()), /unknown runs action/);
  }
  for (const option of ['--unknown', '--host', '--force', 'extra']) {
    await assert.rejects(main(['runs', 'move', option], captureIO()), /unknown runs option/);
  }
});

test('help lists the public runs move command and its usage', async () => {
  const io = captureIO();
  assert.equal(await main(['--help'], io), 0);
  assert.ok(helpCommands(io.output[0]).includes('runs'));
  assert.ok(io.output[0].includes('codex-bridge runs move [--dry-run]'));
  for (const flag of ['-h', '--help']) {
    const actionIO = captureIO();
    assert.equal(await main(['runs', 'move', flag], actionIO), 0);
    assert.ok(actionIO.output[0].includes('codex-bridge runs move [--dry-run]'));
    assert.deepEqual(actionIO.errors, []);
  }
});

// Plan_71 D1: help must be intercepted before handlers can read state, launch or mutate anything.
for (const entry of COMMANDS.filter((candidate) => candidate.section !== 'renamed')) {
  for (const flag of ['-h', '--help']) {
    test(entry.name + ' ' + flag + ' answers help before invoking its handler', async (t) => {
      const handler = t.mock.method(entry, 'handler', () => assert.fail('help must not invoke a handler'));
      const io = captureIO();
      const exitCode = await main([entry.name, flag], io);
      assert.equal(exitCode, 0);
      assert.equal(io.output.length, 1);
      assert.match(io.output[0], /^Usage:/);
      for (const line of entry.usage) assert.ok(io.output[0].includes(line), line);
      assert.deepEqual(io.errors, []);
      assert.equal(handler.mock.callCount(), 0);
    });
  }
}

test('model set -h prints only the set usage lines', async () => {
  const io = captureIO();
  const exitCode = await main(['model', 'set', '-h'], io);
  const entry = COMMANDS.find((candidate) => candidate.name === 'model');
  assert.equal(exitCode, 0);
  assert.match(io.output[0], /^Usage:/);
  const usage = io.output[0].split('\n').filter((line) => line.startsWith('  codex-bridge '));
  assert.deepEqual(usage, entry.actions.set.usage.map((line) => '  ' + line));
  assert.doesNotMatch(io.output[0], /Actions:/);
  assert.deepEqual(io.errors, []);
});

test('model -h lists all four actions', async () => {
  const io = captureIO();
  assert.equal(await main(['model', '-h'], io), 0);
  assert.match(io.output[0], /\nActions:\n/);
  for (const action of ['list', 'set', 'unset', 'speed']) {
    assert.match(io.output[0], new RegExp('^  ' + action + '\\s+', 'm'));
  }
});

test('permissions add --help answers action help', async () => {
  const io = captureIO();
  assert.equal(await main(['permissions', 'add', '--help'], io), 0);
  assert.match(io.output[0], /^Usage:/);
  assert.ok(io.output[0].includes('codex-bridge permissions add [--scope user|project] [--host <path>]'));
  assert.doesNotMatch(io.output[0], /codex-bridge permissions remove/);
  assert.deepEqual(io.errors, []);
});

test('sweep -h still refuses with its rename message', async () => {
  const io = captureIO();
  assert.equal(await main(['sweep', '-h'], io), 2);
  assert.deepEqual(io.output, []);
  assert.deepEqual(io.errors, ['codex-bridge sweep was renamed to codex-bridge unlock; use the new command.']);
});

test('install --host --help remains a missing-value parser error', async () => {
  const io = captureIO();
  await assert.rejects(main(['install', '--host', '--help'], io), /--host requires a value/);
  assert.deepEqual(io.output, []);
  assert.deepEqual(io.errors, []);
});

test('model set --model --help reaches the existing parser instead of answering help', async () => {
  const io = captureIO();
  assert.equal(await main(['model', 'set', '--model', '--help'], io), 2);
  assert.match(io.output[0], /unknown role "--model"/);
  assert.doesNotMatch(io.output[0], /^Usage:/);
  assert.deepEqual(io.errors, []);
});

test('global help includes every public usage and action and the per-command hint', async () => {
  const io = captureIO();
  assert.equal(await main(['--help'], io), 0);
  assert.equal(io.output[0], HELP);
  for (const entry of COMMANDS.filter((candidate) => candidate.section === 'public')) {
    for (const section of [entry, ...Object.values(entry.actions ?? {})]) {
      for (const line of section.usage) assert.ok(io.output[0].includes('  ' + line + '\n'), line);
    }
  }
  assert.ok(io.output[0].includes('Run codex-bridge <command> -h for one command.'));
});

test('every registry entry and action has well-formed help usage', () => {
  for (const entry of COMMANDS) {
    assert.doesNotThrow(() => renderCommandHelp(entry));
    for (const action of Object.keys(entry.actions ?? {})) {
      assert.doesNotThrow(() => renderCommandHelp(entry, action));
    }
  }
});

test('non-help arguments and exit codes pass unchanged through the registry', async (t) => {
  for (const entry of COMMANDS) {
    const argv = ['set', '--model', '--help'];
    const io = captureIO();
    const handler = t.mock.method(entry, 'handler', async (received, receivedIO) => {
      assert.deepEqual(received, argv);
      assert.equal(receivedIO, io);
      return 17;
    });
    assert.equal(await main([entry.name, ...argv], io), 17);
    assert.equal(handler.mock.callCount(), 1);
  }
});

test('the registry and thin entry stay below 400 lines', async () => {
  for (const file of ['cli/command-registry.mjs', 'bin/codex-bridge.mjs']) {
    const source = await fs.readFile(path.join(ROOT, file), 'utf8');
    assert.ok(source.trimEnd().split('\n').length < 400, file);
  }
});
