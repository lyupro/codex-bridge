/** Keeps the dispatcher's commands, its help text, and the README command block in sync. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const BIN = path.join(ROOT, 'bin', 'codex-bridge.mjs');

function unique(commands) {
  return [...new Set(commands)];
}

function dispatcherCommands(source) {
  return unique([...source.matchAll(/command\s*===\s*['"]([a-z][\w-]*)['"]/g)]
    .map(([, command]) => command));
}

function helpCommands(help) {
  const block = help.match(/\nCommands:\n([\s\S]*?)(?:\n\n|$)/);
  assert.ok(block, 'The --help output must contain a Commands block.');
  return [...block[1].matchAll(/^[ \t]{2}([a-z][\w-]*)[ \t]+/gm)]
    .map(([, command]) => command);
}

function readmeCommands(readme) {
  const block = readme.match(/## Install[\s\S]*?```[^\r\n]*\r?\n([\s\S]*?)\r?\n```/);
  assert.ok(block, 'README.md must contain an install command block.');
  return unique([...block[1].matchAll(/(?:npx @lyupro\/codex-bridge|node bin\/codex-bridge\.mjs)\s+([a-z][\w-]*)/g)]
    .map(([, command]) => command));
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
