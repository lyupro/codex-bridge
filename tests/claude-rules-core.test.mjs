/**
 * Guards the always-loaded rules core installed into `<host>/rules/codex-bridge/` (Plan_64 D5, D10).
 *
 * The core is paid for in every session of every project: the inventory measured the full package
 * text at ~1 600 tokens, so D5 keeps only a routing core under a 600-token ceiling. A `paths`
 * frontmatter would turn it into a conditional rule that never loads before the first delegation,
 * and a literal run root would be false before and after the run-records move (D10).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS } from '../src/home/lib/agents.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const corePath = path.join(root, 'src', 'claude', 'rules', 'core.md');
const core = fs.readFileSync(corePath, 'utf8');

// ~4 characters per token for English prose: 600 tokens.
const CORE_CHARACTER_CEILING = 2400;

test('the rules core stays under its token ceiling', () => {
  assert.ok(core.length <= CORE_CHARACTER_CEILING,
    `core.md has ${core.length} characters; the ceiling is ${CORE_CHARACTER_CEILING} (~600 tokens)`);
});

test('the rules core has no frontmatter, so the host loads it at session start', () => {
  assert.doesNotMatch(core, /^---\r?\n/);
  assert.doesNotMatch(core, /^paths\s*:/m);
});

test('the rules core names every dispatcher agent', () => {
  for (const agent of Object.keys(AGENTS)) assert.match(core, new RegExp(`\`${agent}\``), agent);
});

test('the rules core never names a run root', () => {
  assert.doesNotMatch(core, /codex-runs|\.lyupro|\.codex-bridge[\\/]|runs[\\/]/);
});
