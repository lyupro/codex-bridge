/** Prevents shipped dispatcher commands from exposing paths that defeat host permission matching. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AGENTS_DIR = path.join(ROOT, 'src', 'agents');

function commandBlocks(source) {
  return [...source.matchAll(/```(?:bash|sh|shell)\s*\r?\n([\s\S]*?)```/gi)].map((match) => match[1]);
}

test('every shipped agent command crosses the codex-bridge run boundary without internal paths', async () => {
  const names = (await fs.readdir(AGENTS_DIR)).filter((name) => name.endsWith('.md')).sort();
  assert.ok(names.length, 'No shipped agent definitions were found.');
  const forbidden = [
    [/\b[A-Za-z]:/, 'drive letter'],
    [/\\/, 'backslash or line continuation'],
    [/\/(?:Users|home)\//, 'absolute home path'],
    [/\.lyupro/i, '.lyupro path'],
    [/^\s*(?:node|npx|python)\s/im, 'interpreter command'],
    [/\S+\.(?:mjs|js)\b/i, 'JavaScript file command'],
  ];
  for (const name of names) {
    const source = await fs.readFile(path.join(AGENTS_DIR, name), 'utf8');
    const blocks = commandBlocks(source);
    assert.ok(blocks.length, `${name} has no shell command block.`);
    for (const block of blocks) {
      assert.match(block, /^codex-bridge run /, `${name} must invoke the public run command on one line.`);
      assert.equal(block.trim().split(/\r?\n/).length, 1, `${name} command must stay on one line.`);
      for (const [pattern, label] of forbidden) {
        assert.doesNotMatch(block, pattern, `${name} command exposes a forbidden ${label}.`);
      }
    }
  }
});
