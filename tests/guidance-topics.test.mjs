/**
 * Guards the on-demand package texts routed by the rules core (Plan_64 B7b, D5, D9, D10).
 *
 * An advertised topic without an installed source breaks the task-file contract at delegation.
 * Plan_79 D3 removes the unexplained topic cap; D10 requires receipt-based lookup
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
import { renderGuidance } from '../cli/guidance-render.mjs';
import { SHELL_UNSAFE_SEQUENCES } from '../src/home/lib/shell-unsafe.mjs';
import { SCHEMAS } from '../src/home/lib/runner/schemas.mjs';
import { makeTempTree, removeTempTree } from './temp-tree.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const guidanceDir = path.join(root, 'src', 'home', 'guidance');
const topics = Object.keys(GUIDANCE_TOPICS);
const registered = new Set(COMMANDS.map((command) => command.name));
const readTopic = (topic) => fs.readFileSync(path.join(guidanceDir, `${topic}.md`), 'utf8');

function installedHome(t) {
  const home = makeTempTree('guidance-topics-');
  t.after(() => removeTempTree(home));
  fs.cpSync(path.join(root, 'src', 'home'), home, { recursive: true });
  return home;
}

const codeList = (values) => values.map((value) =>
  value.includes('`') ? '`` ' + value + ' ``' : '`' + value + '`').join(', ');

test('the guidance folder contains exactly the registered topic files', () => {
  const entries = fs.readdirSync(guidanceDir, { withFileTypes: true });
  assert.deepEqual(entries.map((entry) => entry.name).sort(), topics.map((topic) => `${topic}.md`).sort());
  for (const entry of entries) assert.ok(entry.isFile(), `${entry.name} must be a file`);
});

for (const topic of topics) {
  test(`${topic} starts with its topic heading`, () => {
    assert.match(readTopic(topic), new RegExp(`^# ${topic}\\r?\\n`));
  });

  test(`${topic} renders from an installed home without placeholders`, async (t) => {
    const home = installedHome(t);
    const text = fs.readFileSync(path.join(home, 'guidance', `${topic}.md`), 'utf8');
    assert.doesNotMatch(await renderGuidance(text, { root: home, topic }), /{{/);
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

test('order renders the shell list in the source array order', async (t) => {
  const text = await renderGuidance(readTopic('order'), { root: installedHome(t), topic: 'order' });
  assert.equal(/Forbidden shell sequences are (.*?)\./.exec(text)?.[1], codeList(SHELL_UNSAFE_SEQUENCES));
});

test('records renders both required review field arrays from the schema', async (t) => {
  const text = await renderGuidance(readTopic('records'), { root: installedHome(t), topic: 'records' });
  const review = SCHEMAS['codex-review'];
  const match = /Top-level fields: (.*?); finding fields: (.*?)\./.exec(text);
  assert.ok(match);
  assert.equal(match[1], codeList(review.required));
  assert.equal(match[2], codeList(review.properties.findings.items.required));
});
