/** Keeps the dispatcher's commands, its help text, and the README command block in sync. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CLI_NAMES } from '../../src/home/lib/cli-names.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const BIN = path.join(ROOT, 'bin', 'codex-bridge.mjs');

function unique(commands) {
  return [...new Set(commands)];
}

function dispatcherCommands(source) {
  return unique([...source.matchAll(/command\s*===\s*['"]([a-z][\w-]*)['"]/g)]
    .map(([, command]) => command)
    // A renamed command remains a migration refusal, not a public help entry.
    .filter((command) => command !== 'sweep'));
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
  const [dispatcher, readme] = await Promise.all([
    fs.readFile(path.join(ROOT, 'bin', 'codex-bridge.mjs'), 'utf8'),
    fs.readFile(path.join(ROOT, 'README.md'), 'utf8'),
  ]);
  const result = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);

  const expected = sorted(dispatcherCommands(dispatcher));
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
  assert.ok(
    packageNames.every((name) => packageJson.bin[name] === './bin/codex-bridge.mjs'),
    'Every binary name must point to the dispatcher entry point.',
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
