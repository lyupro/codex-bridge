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
  ['cli/doctor-fixtures.mjs', migrationReason],
  ['cli/doctor-runtime.test.mjs', migrationReason],
  ['cli/doctor.test.mjs', migrationReason],
  ['cli/hook-subcommand.test.mjs', migrationReason],
  ['cli/host-contract.test.mjs', migrationReason],
  ['cli/host-fixture.mjs', migrationReason],
  ['cli/hosts.test.mjs', migrationReason],
  ['cli/install-record.test.mjs', migrationReason],
  ['cli/install.test.mjs', migrationReason],
  ['cli/invoked-directly.test.mjs', migrationReason],
  ['cli/json-file.test.mjs', migrationReason],
  ['cli/manifest.test.mjs', migrationReason],
  ['cli/permissions.test.mjs', migrationReason],
  ['cli/probe-contract.test.mjs', migrationReason],
  ['cli/projects.test.mjs', migrationReason],
  ['cli/prune-plan.test.mjs', migrationReason],
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
  ['hooks/no-command-rewrite.test.mjs', migrationReason],
  ['hooks/order-gate.test.mjs', migrationReason],
  ['hooks/reply-guard.test.mjs', migrationReason],
  ['hooks/stop-guard.test.mjs', migrationReason],
  ['hooks/worktree-lock.test.mjs', migrationReason],
  ['hooks/worktree-witness.test.mjs', migrationReason],
  ['json-file.test.mjs', migrationReason],
  ['meta/meta-package-version.test.mjs', migrationReason],
  ['meta/pre-start.test.mjs', migrationReason],
  ['meta/transport.test.mjs', migrationReason],
  ['meta/verdict.test.mjs', migrationReason],
  ['retention.test.mjs', migrationReason],
  ['runner/attach-fixtures.mjs', migrationReason],
  ['runner/continuation-grant.test.mjs', migrationReason],
  ['runner/continuation.test.mjs', migrationReason],
  ['runner/conventions.test.mjs', migrationReason],
  ['runner/pre-start.test.mjs', migrationReason],
  ['runner/project-dir.test.mjs', migrationReason],
  ['runner/reply-guard.test.mjs', migrationReason],
  ['runner/scope.test.mjs', migrationReason],
  ['runner/shell-unsafe.test.mjs', migrationReason],
  ['runner/slug.test.mjs', migrationReason],
  ['runner/task-file.test.mjs', migrationReason],
  ['runner/task-input.test.mjs', migrationReason],
  ['shell-unsafe-arguments.test.mjs', migrationReason],
  ['write-meta-outcome.test.mjs', migrationReason],
]);

function findMjsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) return findMjsFiles(target);
    return entry.isFile() && entry.name.endsWith('.mjs') ? [target] : [];
  });
}

function destructuredRemovalNames(source) {
  const names = [];
  const imports = source.matchAll(
    /import\s*{([\s\S]*?)}\s*from\s*['"]node:fs(?:\/promises)?['"]/g,
  );
  for (const [, specifiers] of imports) {
    for (const specifier of specifiers.split(',')) {
      const match = specifier.trim().match(/^(rmSync|rm)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (match) names.push(match[2] ?? match[1]);
    }
  }
  return names;
}

function callsDirectRemoval(source) {
  // Any receiver, not only one spelled `fs`: a file importing `node:fs/promises` as `fsp` removes
  // trees exactly as directly, and a gate that reads the variable name rather than the call is a
  // gate one rename walks past. `removeTempTree` does not match — the member name must be exact.
  if (/\.\s*(?:rmSync|rm)\s*\(/.test(source)) return true;
  return destructuredRemovalNames(source).some((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\s*\\(`).test(source);
  });
}

test('temporary trees are removed through the shared helper', () => {
  const callers = findMjsFiles(testsRoot)
    .map((file) => ({
      file: path.relative(testsRoot, file).replaceAll(path.sep, '/'),
      source: fs.readFileSync(file, 'utf8'),
    }))
    .filter(({ file, source }) => file !== 'temp-tree.mjs' && callsDirectRemoval(source))
    .map(({ file }) => file)
    .sort();
  const unexpected = callers.filter((file) => !exclusions.has(file));
  const stale = [...exclusions.keys()].filter((file) => !callers.includes(file)).sort();

  assert.deepEqual(unexpected, [], `Direct temp removal must migrate to temp-tree.mjs: ${unexpected.join(', ')}`);
  assert.deepEqual(stale, [], `Remove stale temp-removal exclusions: ${stale.join(', ')}`);
});
