#!/usr/bin/env node
/**
 * OW-064: .omc/ disappeared from src/home/guidance/order.md and the Codex build prompt
 * in src/home/lib/runner/prompts.mjs. Complete marked lists must follow the runtime policy;
 * required block counts prevent removing markers from silently disabling this guard.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVICE_FOLDERS } from '../src/home/lib/meta/paths.mjs';
import { listRepositoryPaths } from '../src/home/lib/runner/git-paths.mjs';
import { INSTRUCTIONS } from '../src/home/lib/runner/prompts.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const requiredBlocks = new Map([
  ['src/home/guidance/order.md', 1],
  ['docs/overview.md', 2],
  ['docs/run-lifecycle.md', 1],
]);
const begin = '<!-- service-folders:begin -->';
const end = '<!-- service-folders:end -->';
const folderList = SERVICE_FOLDERS.map((name) => `\`${name}/\``).join(', ');

function checkBlocks(text, file) {
  const errors = [];
  const lines = text.split(/\r?\n/);
  let start = null;
  let count = 0;
  for (const [index, line] of lines.entries()) {
    const marker = line.trim();
    if (marker === begin) {
      if (start !== null) {
        errors.push(`${file}:${index + 1}: nested begin marker (block at line ${start + 1})`);
      } else {
        start = index;
      }
    } else if (marker === end) {
      if (start === null) {
        errors.push(`${file}:${index + 1}: unpaired end marker`);
        continue;
      }
      count += 1;
      const block = lines.slice(start + 1, index).join('\n');
      const tokens = [...block.matchAll(/`([^`\r\n]*\/)`/g)].map((match) => match[1].slice(0, -1));
      const seen = new Set(tokens);
      const missing = SERVICE_FOLDERS.filter((name) => !seen.has(name));
      const unknown = [...seen].filter((name) => !SERVICE_FOLDERS.includes(name));
      const duplicate = [...seen].filter((name) => tokens.filter((token) => token === name).length > 1);
      if (missing.length || unknown.length || duplicate.length) {
        errors.push(`${file}:${start + 1}: missing [${missing.join(', ')}]; ` +
          `unknown [${unknown.map((name) => name || '/').join(', ')}]; ` +
          `duplicate [${duplicate.map((name) => name || '/').join(', ')}]`);
      }
      start = null;
    }
  }
  if (start !== null) errors.push(`${file}:${start + 1}: unpaired begin marker`);
  return { count, errors };
}

function requirePaths(paths) {
  assert.ok(Array.isArray(paths) && paths.length > 0,
    'Service-folder guard requires a non-empty Git repository path listing; discovery failed or returned no files.');
}

function missingBlocks(counts) {
  return [...requiredBlocks].flatMap(([file, expected]) => {
    const actual = counts.get(file) ?? 0;
    return actual === expected ? [] : [`${file}: expected exactly ${expected} service-folder blocks, found ${actual}`];
  });
}

test('every marked repository enumeration matches the service-folder policy', () => {
  const paths = listRepositoryPaths(root);
  requirePaths(paths);
  const counts = new Map();
  const errors = [];
  for (const file of paths) {
    const absolute = path.join(root, file);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isFile()) continue;
    const bytes = fs.readFileSync(absolute);
    if (bytes.includes(0)) continue;
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      continue;
    }
    const result = checkBlocks(text, file);
    counts.set(file, result.count);
    errors.push(...result.errors);
  }
  errors.push(...missingBlocks(counts));
  assert.deepEqual(errors, [], errors.join('\n'));
});

test('discovery failure or an empty repository cannot silently pass', () => {
  for (const paths of [null, []]) assert.throws(() => requirePaths(paths), /non-empty Git repository path listing/);
});

test('blocks are independent, support wrapped CRLF text and ignore unmarked examples', () => {
  const text = ['Example: `.git/`.', begin, folderList.replaceAll(', ', ',\r\n'), end,
    begin, folderList.replace('`.omc/`, ', ''), end].join('\r\n');
  const result = checkBlocks(text, 'space and Unicode-漢.md');
  assert.equal(result.count, 2);
  assert.deepEqual(result.errors, ['space and Unicode-漢.md:10: missing [.omc]; unknown []; duplicate []']);
});

test('a block reports every missing, unknown and duplicate folder with its location', () => {
  const result = checkBlocks([begin, '`.git/`, `.git/`, `.other/`, `.other/`, `.extra/`', end].join('\n'), 'bad.md');
  assert.deepEqual(result.errors, [
    'bad.md:1: missing [.omx, .omc, .claude, .codex, node_modules]; unknown [.other, .extra]; duplicate [.git, .other]',
  ]);
});

test('unpaired and nested markers fail', () => {
  for (const [text, message] of [
    [end, 'unpaired end marker'],
    [begin, 'unpaired begin marker'],
    [[begin, begin, folderList, end, end].join('\n'), 'nested begin marker'],
  ]) {
    const result = checkBlocks(text, 'markers.md');
    assert.ok(result.errors.some((error) => error.includes(message)), result.errors.join('\n'));
  }
});

test('a slash-only inline token is an unknown folder rather than silently ignored', () => {
  const result = checkBlocks([begin, `${folderList}, \`/\`, \`/\``, end].join('\n'), 'empty-name.md');
  assert.deepEqual(result.errors, ['empty-name.md:1: missing []; unknown [/]; duplicate [/]']);
});

test('removing all markers or an overview block fails the required-presence contract', () => {
  assert.equal(missingBlocks(new Map()).length, 3);
  const counts = new Map(requiredBlocks);
  counts.set('docs/overview.md', 1);
  assert.deepEqual(missingBlocks(counts), ['docs/overview.md: expected exactly 2 service-folder blocks, found 1']);
  counts.set('docs/overview.md', 3);
  assert.deepEqual(missingBlocks(counts), ['docs/overview.md: expected exactly 2 service-folder blocks, found 3']);
});

test('the rendered Codex build instruction names every service folder once in inline code', () => {
  const prompt = INSTRUCTIONS['codex-build']({ verify: 'targeted tests' });
  const match = /- Do not fix the environment\. Service directories \(([^)]*)\)/.exec(prompt);
  assert.ok(match, 'Missing service-directory instruction');
  assert.equal(match[1], folderList);
});
