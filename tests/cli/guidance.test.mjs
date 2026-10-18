/** Guards installed-home guidance routing and refusals (Plan_64 B4). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { guidance } from '../../cli/guidance.mjs';
import { GUIDANCE_TOPICS } from '../../cli/guidance-topics.mjs';
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

test('guidance always returns a Promise for usage, read errors and rendering', async (t) => {
  const { home, env } = homeFixture(t);
  fs.mkdirSync(path.join(home, 'guidance'));
  fs.writeFileSync(path.join(home, 'guidance', 'order.md'), 'Installed rules');
  fs.writeFileSync(path.join(home, 'guidance', 'records.md'), '{{unknown-field}}');
  for (const [argv, exitCode] of [
    [[], 0], [['unknown'], 2], [['order', 'records'], 2],
    [['budget'], 1], [['order'], 0], [['records'], 1],
  ]) {
    await guidance(argv, { env }).then((result) => assert.equal(result.exitCode, exitCode));
  }
});

test('guidance lists the finite topics in order with summaries and usage', async (t) => {
  const { env } = homeFixture(t);
  const result = await guidance([], { env });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(Object.keys(GUIDANCE_TOPICS), ['order', 'advisor', 'budget', 'records', 'concurrency']);
  assertTopics(result.output);
  assert.deepEqual(result.output.split('\n').slice(1, 6),
    Object.entries(GUIDANCE_TOPICS).map(([topic, summary]) => `  ${topic} — ${summary}`));
});

test('guidance prints each installed topic verbatim from the injected home', async (t) => {
  const { home, env } = homeFixture(t);
  fs.mkdirSync(path.join(home, 'guidance'));
  for (const topic of Object.keys(GUIDANCE_TOPICS)) {
    const text = `\uFEFF# ${topic}\r\n\r\nDetailed rules — naïve.  \r\n\n`;
    fs.writeFileSync(path.join(home, 'guidance', `${topic}.md`), text);
    assert.deepEqual(await guidance([topic], { env }), { exitCode: 0, output: text });
  }
});

test('guidance also resolves the default brand home from an injected homedir', async (t) => {
  const { home } = homeFixture(t);
  const dir = path.join(home, '.lyupro', '.codex-bridge', 'guidance');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'order.md'), 'Default home rules');
  assert.deepEqual(await guidance(['order'], { env: {}, homedir: home }),
    { exitCode: 0, output: 'Default home rules' });
});

test('guidance refuses unknown topics, including inherited names and traversal', async (t) => {
  const { env } = homeFixture(t);
  for (const topic of ['unknown', 'toString', '__proto__', '../order']) {
    const result = await guidance([topic], { env });
    assert.equal(result.exitCode, 2);
    assert.ok(result.output.includes(`Unknown guidance topic "${topic}"`));
    assertTopics(result.output);
  }
});

test('guidance refuses two arguments and lists the topics', async (t) => {
  const { env } = homeFixture(t);
  const result = await guidance(['order', 'advisor'], { env });
  assert.equal(result.exitCode, 2);
  assert.match(result.output, /at most one topic/);
  assertTopics(result.output);
});

test('missing guidance names the absolute home path and the update command', async (t) => {
  const { home, env } = homeFixture(t);
  const result = await guidance(['order'], { env });
  assert.equal(result.exitCode, 1);
  assert.ok(result.output.includes(path.join(home, 'guidance', 'order.md')));
  assert.match(result.output, /run codex-bridge update/);
});

test('unreadable guidance names the home path and asks for update', async (t) => {
  const { home, env } = homeFixture(t);
  const file = path.join(home, 'guidance', 'order.md');
  const readFileSync = fs.readFileSync;
  // Permission bits do not reliably refuse reads on Windows; inject the filesystem refusal.
  t.mock.method(fs, 'readFileSync', (target, ...args) => {
    if (target === file) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    return readFileSync(target, ...args);
  });
  const result = await guidance(['order'], { env });
  assert.equal(result.exitCode, 1);
  assert.ok(result.output.includes(file));
  assert.match(result.output, /permission denied/);
  assert.match(result.output, /run codex-bridge update/);
});

test('missing installed guidance never falls back to a readable clone seed', async (t) => {
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
  const result = await guidance(['order'], { env });
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

test('main awaits installed rendering and preserves existing output routing', async (t) => {
  const { home, env } = homeFixture(t);
  fs.mkdirSync(path.join(home, 'guidance'));
  fs.mkdirSync(path.join(home, 'lib'));
  fs.writeFileSync(path.join(home, 'lib', 'shell-unsafe.mjs'),
    'export const SHELL_UNSAFE_SEQUENCES = ["installed-only"];');
  fs.writeFileSync(path.join(home, 'guidance', 'order.md'), 'Forbidden: {{shell-unsafe-sequences}}');
  const previous = process.env.CODEX_BRIDGE_HOME;
  process.env.CODEX_BRIDGE_HOME = env.CODEX_BRIDGE_HOME;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_BRIDGE_HOME;
    else process.env.CODEX_BRIDGE_HOME = previous;
  });
  const logs = [];
  const errors = [];
  const io = { log: (text) => logs.push(text), error: (text) => errors.push(text) };
  assert.equal(await main(['guidance', 'order'], io), 0);
  assert.deepEqual(logs, ['Forbidden: `installed-only`']);
  fs.writeFileSync(path.join(home, 'guidance', 'records.md'), '{{unknown-field}}');
  assert.equal(await main(['guidance', 'records'], io), 1);
  assert.equal(logs.length, 2);
  assert.deepEqual(errors, []);
  assert.match(logs[1], /topic "records"/);
  assert.ok(logs[1].includes('{{unknown-field}}'));
  assert.ok(logs[1].endsWith('run codex-bridge update'));
});

test('unknown installed placeholders return exit 1 naming the topic and placeholder', async (t) => {
  const { home, env } = homeFixture(t);
  fs.mkdirSync(path.join(home, 'guidance'));
  fs.writeFileSync(path.join(home, 'guidance', 'order.md'), '{{unknown-field}}');
  const result = await guidance(['order'], { env });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /topic "order"/);
  assert.ok(result.output.includes('{{unknown-field}}'));
  assert.ok(result.output.endsWith('run codex-bridge update'));
});

test('unresolved installed templates return exit 1 with the update remedy', async (t) => {
  const { home, env } = homeFixture(t);
  fs.mkdirSync(path.join(home, 'guidance'));
  fs.writeFileSync(path.join(home, 'guidance', 'records.md'), 'Fields: {{unfinished');
  const result = await guidance(['records'], { env });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /topic "records"/);
  assert.ok(result.output.includes('{{unfinished'));
  assert.ok(result.output.endsWith('run codex-bridge update'));
});

test('missing installed value modules return exit 1 for either placeholder', async (t) => {
  const { home, env } = homeFixture(t);
  fs.mkdirSync(path.join(home, 'guidance'));
  for (const [topic, placeholder] of [
    ['order', '{{shell-unsafe-sequences}}'], ['records', '{{review-required-fields}}'],
  ]) {
    fs.writeFileSync(path.join(home, 'guidance', `${topic}.md`), placeholder);
    const result = await guidance([topic], { env });
    assert.equal(result.exitCode, 1);
    assert.ok(result.output.includes(`topic "${topic}"`));
    assert.ok(result.output.includes(placeholder));
    assert.match(result.output, /Cannot find module/);
    assert.ok(result.output.endsWith('run codex-bridge update'));
  }
});

test('advisor guidance distinguishes failed-pass repairs from phase grants (Plan_80 E4)', () => {
  // Facts, not wording: a topic that names only retry: sends the orchestrator to a fresh thread.
  const text = fs.readFileSync(new URL('../../src/home/guidance/advisor.md', import.meta.url), 'utf8');
  assert.match(text, /`retry: <run folder> — <reason>`[^.]*fresh thread/);
  assert.match(text, /`resume: <run folder> — <reason>`[^.]*own Codex thread/);
  assert.match(text, /`resume-grant-usable`/);
  assert.match(text, /Neither `retry:` nor `resume:` authorizes the next phase/);
});

test('records guidance follows the newest resumed run and preserves the review template (Plan_80 E4)', () => {
  const text = fs.readFileSync(new URL('../../src/home/guidance/records.md', import.meta.url), 'utf8');
  assert.match(text, /`resumed_from`/);
  assert.match(text, /`resume-note\.md`/);
  assert.match(text, /newest run of the chain/);
  assert.ok(text.includes('{{review-required-fields}}'));
});
