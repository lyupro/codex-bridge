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

test('recognises numbered file-descriptor redirections', () => {
  // Protect the optional descriptor branch without broadening matches to descriptor duplication.
  const cases = [
    ['node build.mjs 2> errors.log', ['errors.log']],
    ['printf x 1> out.txt', ['out.txt']],
  ];
  for (const [command, paths] of cases) {
    assert.deepEqual(shellWriteIntent(command), { writes: true, paths }, command);
  }
});

test('excludes descriptor duplication and comparison shapes from redirection writes', () => {
  // Protect both redirection guards from treating shell syntax as a file target.
  for (const command of [
    'make 2>&1',
    'printf oops >&2',
    '[ "$a" -gt 5 ] && echo big',
  ]) {
    assert.deepEqual(shellWriteIntent(command), { writes: false, paths: [] }, command);
  }
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

test('matches path-qualified command names by their basename', () => {
  // Protect separator stripping and the `.exe` suffix the platform adds: the smoke run of
  // 2026-08-17 recorded `sed.exe -i` as a non-write, which is the gap itself, not a boundary.
  const cases = [
    ['/usr/bin/tee out.txt', { writes: true, paths: ['out.txt'] }],
    [String.raw`C:\tools\sed.exe -i 's/a/b/' src/file.mjs`, { writes: true, paths: ['src/file.mjs'] }],
  ];
  for (const [command, expected] of cases) {
    assert.deepEqual(shellWriteIntent(command), expected, command);
  }
});

test('reports a single-source cp without inventing a destination path', () => {
  // Protect the positional-count guard: the command is a write form even without a named target.
  assert.deepEqual(shellWriteIntent('cp -r src'), { writes: true, paths: [] });
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

test('recognises executable-suffixed interpreters but not unrelated heredoc consumers', () => {
  // Protect the interpreter suffix branch and the deliberate non-interpreter heredoc boundary.
  const cases = [
    [
      "python.exe - <<'PY'\nwrite('CHANGELOG.md', 'changed')\nPY",
      { writes: true, paths: ['CHANGELOG.md'] },
    ],
    ["cat <<'EOF'\ntext\nEOF", { writes: false, paths: [] }],
  ];
  for (const [command, expected] of cases) {
    assert.deepEqual(shellWriteIntent(command), expected, command);
  }
});

test('returns the empty result for blank and non-string input', () => {
  // Protect the entry guard so unsupported input cannot reach shell-pattern matching.
  for (const input of ['', '   ', null, undefined, 42]) {
    assert.deepEqual(shellWriteIntent(input), { writes: false, paths: [] }, String(input));
  }
});

test('plain reads and unrelated shell commands do not claim write intent', () => {
  assert.deepEqual(shellWriteIntent('git status --short'), { writes: false, paths: [] });
  assert.deepEqual(shellWriteIntent('sed -n 1,20p src/file.mjs'), { writes: false, paths: [] });
});
