/** Keeps the dispatcher's commands, its help text, and the README command block in sync. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CLI_NAMES } from '../../src/home/lib/cli-names.mjs';
import { commandOptions, HELP, main } from '../../bin/codex-bridge.mjs';
import { COMMANDS } from '../../cli/command-registry.mjs';
import { renderCommandHelp } from '../../cli/command-help.mjs';

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
