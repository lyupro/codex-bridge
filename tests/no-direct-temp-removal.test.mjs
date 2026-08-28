#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsRoot = path.dirname(fileURLToPath(import.meta.url));
// Not a tree removal and never will be: the test deletes one artifact file from a run to say the
// artifact is missing, which is what the witness is being asked about. The gate deliberately does
// not learn to tell a file from a tree — narrowing it to `recursive: true` was considered in batch
// two and rejected, because a tree can then be removed one file at a time and the rule goes back to
// being a convention.
const singleArtifactReason = 'Removes single run artifacts to express a missing file, not trees.';
const installerOwnedReason = 'Removes installer-owned files to exercise missing-file recovery, not trees.';
const lockReleaseReason = 'Releases a held lock file on a timer to play its holder, not a tree removal.';
const exclusions = new Map([
  ['cli/doctor.test.mjs', installerOwnedReason],
  ['cli/doctor-rules.test.mjs', installerOwnedReason],
  ['cli/install.test.mjs', installerOwnedReason],
  // The test writes the lock file itself to stand in for a live holder, then removes it on a timer
  // so the holder is seen releasing it: the removal is the thing being tested (2026-08-11 — the
  // product must wait for a lock it does not own rather than steal it), not cleanup.
  ['cli/rules-owners.test.mjs', lockReleaseReason],
  ['cli/uninstall.test.mjs', installerOwnedReason],
  // The files this one removes were written by a real install(), not by a fixture: the test deletes
  // an installed file to prove update refuses and --force restores it. Not a tree removal.
  ['cli/update.test.mjs', installerOwnedReason],
  ['hooks/worktree-witness.test.mjs', singleArtifactReason],
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
