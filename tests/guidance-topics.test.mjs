/**
 * Guards the on-demand package texts routed by the rules core (Plan_64 B7b, D5, D9, D10).
 *
 * An advertised topic without an installed source breaks the task-file contract at delegation.
 * D5 keeps details bounded and outside the always-loaded core; D10 requires receipt-based lookup
 * because a literal run-store root becomes false when records move. Command references must stay
 * in the registry so the package never ships guidance that sends a caller to a missing command.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS } from '../cli/command-registry.mjs';
import { GUIDANCE_TOPICS } from '../cli/guidance.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const guidanceDir = path.join(root, 'src', 'home', 'guidance');
const topics = Object.keys(GUIDANCE_TOPICS);
const registered = new Set(COMMANDS.map((command) => command.name));
const readTopic = (topic) => fs.readFileSync(path.join(guidanceDir, `${topic}.md`), 'utf8');

test('the guidance folder contains exactly the registered topic files', () => {
  const entries = fs.readdirSync(guidanceDir, { withFileTypes: true });
  assert.deepEqual(entries.map((entry) => entry.name).sort(), topics.map((topic) => `${topic}.md`).sort());
  for (const entry of entries) assert.ok(entry.isFile(), `${entry.name} must be a file`);
});

for (const topic of topics) {
  test(`${topic} starts with its topic heading`, () => {
    assert.match(readTopic(topic), new RegExp(`^# ${topic}\\r?\\n`));
  });

  test(`${topic} stays under 4 000 characters`, () => {
    const text = readTopic(topic);
    assert.ok(text.length < 4000, `${topic}.md has ${text.length} characters; it must stay under 4000`);
  });

  test(`${topic} never names a run-store root`, () => {
    assert.doesNotMatch(readTopic(topic), /codex-runs|\.lyupro|\.codex-bridge[\\/]|runs[\\/]/);
  });

  test(`${topic} names only registered commands`, () => {
    for (const match of readTopic(topic).matchAll(/`codex-bridge\s+(\w+)/g)) {
      assert.ok(registered.has(match[1]), `${topic}.md names unregistered command: ${match[1]}`);
    }
  });
}
