/** Prevents shipped dispatcher commands from exposing paths that defeat host permission matching. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replacePlaceholders } from '../cli/manifest.mjs';
import { canonicalRunCommand, renderRunCommandTemplate } from '../src/home/lib/dispatcher-command.mjs';
import { orderSpellings } from './order-spelling-scan.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGENTS_DIR = path.join(ROOT, 'src', 'agents');
const INSTALLATION_ROOT = path.join(os.tmpdir(), 'bridge-command-boundary-host');

function commandBlocks(source) {
  return [...source.matchAll(/```(?:bash|sh|shell)\s*\r?\n([\s\S]*?)```/gi)].map((match) => match[1]);
}

function commandLikeText(source) {
  const fences = [...source.matchAll(/```[^\r\n]*\r?\n([\s\S]*?)```/g)].map((match) => match[1]);
  const inline = [...source.matchAll(/`([^`\r\n]*\s+[^`\r\n]*)`/g)].map((match) => match[1]);
  const prose = source.split(/\r?\n/)
    .map((line) => line.match(/\b(?:run|execute|invoke|start)\s+(.+)/i)?.[1])
    .filter(Boolean);
  return [...fences, ...inline, ...prose].join('\n');
}

function assertSafeAgentDefinition(source, name) {
  const blocks = commandBlocks(source);
  assert.ok(blocks.length, `${name} has no canonical shell command block.`);
  for (const block of blocks) {
    assert.match(block, /^codex-bridge run /, `${name} must invoke the public run command on one line.`);
    assert.equal(block.trim().split(/\r?\n/).length, 1, `${name} command must stay on one line.`);
  }

  // The 2026-08-15 review found that checking tagged fences alone lets the same host command
  // return through prose, inline code, or an untagged fence. Scan every command-shaped region,
  // while leaving ordinary artifact names and explanatory ~/.claude paths alone.
  const commands = commandLikeText(source);
  const forbidden = [
    [/\b[A-Za-z]:[\\/]/, 'drive-letter path'],
    [/(?:^|\s)\/(?:Users|home)\//m, 'absolute home path'],
    [/\.lyupro/i, '.lyupro path'],
    [/(?:^|\n)\s*(?:node|npx|python)\s/im, 'interpreter command'],
    [/(?:^|\s)(?:\.\.?[\\/]|~[\\/]|[A-Za-z]:[\\/])?\S+\.(?:mjs|js)(?=\s|$)/im, 'JavaScript file command'],
    [/\\[ \t]*$/m, 'line continuation'],
  ];
  for (const [pattern, label] of forbidden) {
    assert.doesNotMatch(commands, pattern, `${name} exposes a forbidden ${label}.`);
  }

  // Plan_63 D11: markdown is not JavaScript; never mask comments or prose in installed prompts.
  for (const spelling of [...orderSpellings(), '--no-wait', '--question', '--verify']) {
    const escaped = spelling.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(?<![A-Za-z0-9-])${escaped}(?![A-Za-z0-9-])`);
    assert.doesNotMatch(source, pattern, `${name} exposes retired flag ${spelling}.`);
  }
}

test('every shipped agent command crosses the codex-bridge run boundary without internal paths', async () => {
  const names = (await fs.readdir(AGENTS_DIR)).filter((name) => name.endsWith('.md')).sort();
  assert.equal(names.length, 4, 'All four shipped agent definitions must be checked.');
  for (const name of names) {
    const source = await fs.readFile(path.join(AGENTS_DIR, name), 'utf8');
    const rendered = replacePlaceholders(source, INSTALLATION_ROOT);
    const agent = path.basename(name, '.md');
    assertSafeAgentDefinition(rendered, name);
    const fences = [...rendered.matchAll(/^```bash\r?\n([\s\S]*?)```/gm)];
    assert.equal(fences.length, 1, `${name} must have exactly one bash command fence.`);
    const command = fences[0][1].replace(/\r?\n$/, '');
    assert.equal(command, renderRunCommandTemplate(agent), name);
    assert.equal(command.replace('<task-file path from the orchestrator>', 'C:/scratch/task.md'),
      canonicalRunCommand(agent, 'task file: C:/scratch/task.md').command, name);
    assert.ok(!rendered.includes('{{'), `${name} must not retain placeholders.`);
  }
});

test('the four dispatcher prompts retry the identical command without --no-wait', async () => {
  for (const name of ['codex-build.md', 'codex-scout.md', 'codex-review.md', 'codex-advisor.md']) {
    const source = replacePlaceholders(await fs.readFile(path.join(AGENTS_DIR, name), 'utf8'), INSTALLATION_ROOT);
    assert.doesNotMatch(source, /--no-wait/, `${name} must not offer --no-wait.`);
    assert.match(source, /run the identical command again/, `${name} must explain the identical-command retry.`);
  }
});

test('whole-definition guard rejects a retired flag added to a rendered prompt', async () => {
  const source = await fs.readFile(path.join(AGENTS_DIR, 'codex-review.md'), 'utf8');
  const rendered = replacePlaceholders(source, INSTALLATION_ROOT);
  assertSafeAgentDefinition(rendered, 'codex-review.md');
  const spelling = orderSpellings().find((flag) => flag.slice(2) === 'continue');
  assert.ok(spelling, 'The retired spelling registry must include the continuation flag.');
  assert.throws(
    () => assertSafeAgentDefinition(`${rendered}\nadd ${spelling}\n`, 'mutated.md'),
    (err) => err?.name === 'AssertionError' && err.message.includes(spelling),
  );
});

test('whole-definition guard rejects command regressions outside tagged shell fences', () => {
  const safe = '```bash\ncodex-bridge run --agent codex-review\n```\n';
  const mutations = [
    ['prose drive path', 'Run C:/host/lib/run-codex.mjs --agent codex-review.', /drive-letter path/],
    ['untagged fence', '```\nnode ./run-codex.mjs --agent codex-review\n```', /interpreter command/],
    [
      'inline command',
      'Tell the dispatcher to run `node "C:/host/lib/run-codex.mjs" --agent codex-review`.',
      /drive-letter path/,
    ],
    ['absolute home path', 'Execute /home/operator/run-codex.mjs --agent codex-review.', /absolute home path/],
    ['.lyupro path', 'Invoke codex-bridge run ~/.lyupro/run-codex.mjs.', /\.lyupro path/],
    ['JavaScript command', 'Start ./run-codex.js --agent codex-review.', /JavaScript file command/],
    ['line continuation', '```text\ncodex-bridge run \\\n  --agent codex-review\n```', /line continuation/],
  ];
  for (const [label, mutation, expected] of mutations) {
    assert.throws(
      () => assertSafeAgentDefinition(`${safe}${mutation}\n`, 'mutated.md'),
      (err) => err?.name === 'AssertionError' && expected.test(err.message),
      label,
    );
  }
});
