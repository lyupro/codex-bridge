#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsRoot = path.dirname(fileURLToPath(import.meta.url));
const migrationReason = 'Awaiting migration under Plan_53.';
const exclusions = new Map([
  ['check-file-size.test.mjs', migrationReason],
  ['cli/codex-bridge.test.mjs', migrationReason],
  ['cli/doctor.test.mjs', migrationReason],
  ['cli/hook-subcommand.test.mjs', migrationReason],
  ['cli/host-contract.test.mjs', migrationReason],
  ['cli/hosts.test.mjs', migrationReason],
  ['cli/install.test.mjs', migrationReason],
  ['cli/install-record.test.mjs', migrationReason],
  ['cli/probe-contract.test.mjs', migrationReason],
  ['cli/projects.test.mjs', migrationReason],
  ['cli/prune.test.mjs', migrationReason],
  ['cli/read.test.mjs', migrationReason],
  ['cli/remove-layout.test.mjs', migrationReason],
  ['cli/rules-owners.test.mjs', migrationReason],
  ['cli/runs-inventory.test.mjs', migrationReason],
  ['cli/seeded-files.test.mjs', migrationReason],
  ['cli/settings-merge.test.mjs', migrationReason],
  ['cli/stop.test.mjs', migrationReason],
  ['cli/uninstall.test.mjs', migrationReason],
  ['cli/unlock.test.mjs', migrationReason],
  ['cli/update-legacy-layout.test.mjs', migrationReason],
  ['cli/update.test.mjs', migrationReason],
  ['heartbeat.test.mjs', migrationReason],
  ['json-file.test.mjs', migrationReason],
  ['meta/paths.test.mjs', migrationReason],
  ['meta/run-state.test.mjs', migrationReason],
  ['process-identity.test.mjs', migrationReason],
  ['retention.test.mjs', migrationReason],
  ['run-codex.test.mjs', migrationReason],
  ['run-config.test.mjs', migrationReason],
  ['shell-unsafe-arguments.test.mjs', migrationReason],
]);

function findMjsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) return findMjsFiles(target);
    return entry.isFile() && entry.name.endsWith('.mjs') ? [target] : [];
  });
}

function destructuredCreationNames(source) {
  const names = [];
  const imports = source.matchAll(
    /import\s*{([\s\S]*?)}\s*from\s*['"]node:fs(?:\/promises)?['"]/g,
  );
  for (const [, specifiers] of imports) {
    for (const specifier of specifiers.split(',')) {
      const match = specifier.trim().match(/^(mkdtempSync|mkdtemp)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (match) names.push(match[2] ?? match[1]);
    }
  }
  return names;
}

function callsDirectCreation(source) {
  // Any receiver, not only one spelled `fs`: direct mkdtemp calls let fixture trees escape the
  // shared registry, and a gate that reads the variable name rather than the member is renamed past.
  if (/\.\s*(?:mkdtempSync|mkdtemp)\s*\(/.test(source)) return true;
  return destructuredCreationNames(source).some((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\s*\\(`).test(source);
  });
}

test('temporary trees are created through the shared helper', () => {
  const callers = findMjsFiles(testsRoot)
    .map((file) => ({
      file: path.relative(testsRoot, file).replaceAll(path.sep, '/'),
      source: fs.readFileSync(file, 'utf8'),
    }))
    .filter(({ file, source }) => file !== 'temp-tree.mjs' && callsDirectCreation(source))
    .map(({ file }) => file)
    .sort();
  const unexpected = callers.filter((file) => !exclusions.has(file));
  const stale = [...exclusions.keys()].filter((file) => !callers.includes(file)).sort();

  assert.deepEqual(unexpected, [], `Direct temp creation must migrate to temp-tree.mjs: ${unexpected.join(', ')}`);
  assert.deepEqual(stale, [], `Remove stale temp-creation exclusions: ${stale.join(', ')}`);
});
