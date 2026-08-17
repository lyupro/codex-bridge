/** Verifies the deliberately narrow shell write-intent recogniser. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shellWriteIntent } from '../../src/home/hooks/shell-write-intent.mjs';

test('recognises output redirection and preserves its named target', () => {
  assert.deepEqual(shellWriteIntent('printf changed >> "docs/run log.txt"'), {
    writes: true,
    paths: ['docs/run log.txt'],
  });
});

test('recognises the short list of obvious file-writing commands', () => {
  const cases = [
    ['cat input | tee output.txt', ['output.txt']],
    ["sed -i 's/old/new/' src/file.mjs", ['src/file.mjs']],
    ['cp source.txt dist/copy.txt', ['dist/copy.txt']],
    ['mv old.txt archive/new.txt', ['archive/new.txt']],
    ['rm obsolete.txt', ['obsolete.txt']],
    ['touch created.txt', ['created.txt']],
    ['truncate -s0 cache.bin', ['cache.bin']],
  ];
  for (const [command, paths] of cases) {
    assert.deepEqual(shellWriteIntent(command), { writes: true, paths }, command);
  }
});

test('recognises heredocs for each named interpreter and extracts path-like quoted strings', () => {
  for (const interpreter of ['python', 'node', 'perl', 'ruby']) {
    const command = `${interpreter} - <<'SCRIPT'\nwrite('CHANGELOG.md', 'changed')\nSCRIPT`;
    assert.deepEqual(
      shellWriteIntent(command),
      { writes: true, paths: ['CHANGELOG.md'] },
      interpreter,
    );
  }
});

test('plain reads and unrelated shell commands do not claim write intent', () => {
  assert.deepEqual(shellWriteIntent('git status --short'), { writes: false, paths: [] });
  assert.deepEqual(shellWriteIntent('sed -n 1,20p src/file.mjs'), { writes: false, paths: [] });
});
