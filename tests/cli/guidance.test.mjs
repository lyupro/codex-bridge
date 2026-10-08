/** Guards installed-home guidance routing and refusals (Plan_64 B4). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { guidance, GUIDANCE_TOPICS } from '../../cli/guidance.mjs';
import { COMMANDS } from '../../cli/command-registry.mjs';
import { main } from '../../bin/codex-bridge.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

function homeFixture(t) {
  const home = makeTempTree('guidance-');
  t.after(() => removeTempTree(home));
  return { home, env: { CODEX_BRIDGE_HOME: home } };
}

function assertTopics(output) {
  for (const [topic, summary] of Object.entries(GUIDANCE_TOPICS)) {
    assert.ok(output.includes(`  ${topic} — ${summary}`), topic);
  }
  assert.ok(output.includes('Usage: codex-bridge guidance [<topic>]'));
}

test('guidance lists the finite topics in order with summaries and usage', (t) => {
  const { env } = homeFixture(t);
  const result = guidance([], { env });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(Object.keys(GUIDANCE_TOPICS), ['order', 'advisor', 'budget', 'records', 'concurrency']);
  assertTopics(result.output);
  assert.deepEqual(result.output.split('\n').slice(1, 6),
    Object.entries(GUIDANCE_TOPICS).map(([topic, summary]) => `  ${topic} — ${summary}`));
});

test('guidance prints each installed topic verbatim from the injected home', (t) => {
  const { home, env } = homeFixture(t);
  fs.mkdirSync(path.join(home, 'guidance'));
  for (const topic of Object.keys(GUIDANCE_TOPICS)) {
    const text = `\uFEFF# ${topic}\r\n\r\nDetailed rules — naïve.  \r\n\n`;
    fs.writeFileSync(path.join(home, 'guidance', `${topic}.md`), text);
    assert.deepEqual(guidance([topic], { env }), { exitCode: 0, output: text });
  }
});

test('guidance also resolves the default brand home from an injected homedir', (t) => {
  const { home } = homeFixture(t);
  const dir = path.join(home, '.lyupro', '.codex-bridge', 'guidance');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'order.md'), 'Default home rules');
  assert.deepEqual(guidance(['order'], { env: {}, homedir: home }),
    { exitCode: 0, output: 'Default home rules' });
});

test('guidance refuses unknown topics, including inherited names and traversal', (t) => {
  const { env } = homeFixture(t);
  for (const topic of ['unknown', 'toString', '__proto__', '../order']) {
    const result = guidance([topic], { env });
    assert.equal(result.exitCode, 2);
    assert.ok(result.output.includes(`Unknown guidance topic "${topic}"`));
    assertTopics(result.output);
  }
});

test('guidance refuses two arguments and lists the topics', (t) => {
  const { env } = homeFixture(t);
  const result = guidance(['order', 'advisor'], { env });
  assert.equal(result.exitCode, 2);
  assert.match(result.output, /at most one topic/);
  assertTopics(result.output);
});

test('missing guidance names the absolute home path and the update command', (t) => {
  const { home, env } = homeFixture(t);
  const result = guidance(['order'], { env });
  assert.equal(result.exitCode, 1);
  assert.ok(result.output.includes(path.join(home, 'guidance', 'order.md')));
  assert.match(result.output, /run codex-bridge update/);
});

test('unreadable guidance names the home path and asks for update', (t) => {
  const { home, env } = homeFixture(t);
  const file = path.join(home, 'guidance', 'order.md');
  const readFileSync = fs.readFileSync;
  // Permission bits do not reliably refuse reads on Windows; inject the filesystem refusal.
  t.mock.method(fs, 'readFileSync', (target, ...args) => {
    if (target === file) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    return readFileSync(target, ...args);
  });
  const result = guidance(['order'], { env });
  assert.equal(result.exitCode, 1);
  assert.ok(result.output.includes(file));
  assert.match(result.output, /permission denied/);
  assert.match(result.output, /run codex-bridge update/);
});

test('missing installed guidance never falls back to a readable clone seed', (t) => {
  const { home, env } = homeFixture(t);
  const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
  const cloneFile = path.join(root, 'src', 'home', 'guidance', 'order.md');
  const reads = [];
  const readFileSync = fs.readFileSync;
  // The 2026-08-26 incident requires a readable seed to remain irrelevant when home is missing.
  t.mock.method(fs, 'readFileSync', (target, ...args) => {
    reads.push(target);
    if (target === cloneFile) return 'Clone seed must never be printed';
    return readFileSync(target, ...args);
  });
  const result = guidance(['order'], { env });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(reads, [path.join(home, 'guidance', 'order.md')]);
  assert.doesNotMatch(result.output, /Clone seed/);
});

test('guidance is public and reachable through main, with usage errors on io.error', async () => {
  const entry = COMMANDS.find((command) => command.name === 'guidance');
  assert.equal(entry.section, 'public');
  assert.equal(entry.summary, "Print the package's detailed rules for one topic");
  assert.deepEqual(entry.usage, ['codex-bridge guidance [<topic>]']);
  const logs = [];
  const errors = [];
  const io = { log: (text) => logs.push(text), error: (text) => errors.push(text) };
  assert.equal(await main(['guidance'], io), 0);
  assertTopics(logs[0]);
  assert.deepEqual(errors, []);
  for (const args of [['unknown'], ['order', 'advisor']]) {
    assert.equal(await main(['guidance', ...args], io), 2);
  }
  assert.equal(logs.length, 1);
  assert.equal(errors.length, 2);
  for (const output of errors) assertTopics(output);
});
