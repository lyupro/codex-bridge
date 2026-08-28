#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsRoot = path.dirname(fileURLToPath(import.meta.url));
// Empty on purpose since Plan_53 batch 6c: every test file creates its temporary trees through the
// helper, so nothing needs excusing. An entry here is not a normal thing to add — a new direct
// mkdtemp means the tree is born outside the suite's own root, which is what the helper exists to
// prevent. Migrate the caller instead.
const exclusions = new Map();

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
