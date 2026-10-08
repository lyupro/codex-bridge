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
import { COMMANDS } from '../cli/command-registry.mjs';
import { GUIDANCE_TOPICS } from '../cli/guidance.mjs';

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

// Plan_64 B4: the always-loaded router must never send an orchestrator to a missing command.
test('every command named by the rules core is registered', () => {
  const registered = new Set(COMMANDS.map((command) => command.name));
  const named = [...core.matchAll(/`codex-bridge\s+(\w+)/g)].map((match) => match[1]);
  assert.ok(named.length > 0, 'the core must name its routing commands');
  for (const command of named) assert.ok(registered.has(command), `unregistered command: ${command}`);
});

test('the rules core and guidance table name exactly the same topics', () => {
  const named = new Set([...core.matchAll(/`codex-bridge guidance ([a-z][a-z-]*)`/g)]
    .map((match) => match[1]));
  const list = core.match(/`codex-bridge guidance <topic>`([\s\S]*?)`codex-bridge guidance`/);
  assert.ok(list, 'the core must list topics after the guidance routing instruction');
  for (const match of list[1].matchAll(/`([a-z][a-z-]*)`/g)) named.add(match[1]);
  for (const topic of named) assert.ok(Object.hasOwn(GUIDANCE_TOPICS, topic), `unknown topic: ${topic}`);
  for (const topic of Object.keys(GUIDANCE_TOPICS)) assert.ok(named.has(topic), `topic absent from core: ${topic}`);
});
