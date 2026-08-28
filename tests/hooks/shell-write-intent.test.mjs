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

test('ignores redirect characters inside quoted arguments', () => {
  const commands = [
    String.raw`awk '/^Host x/' ~/.ssh/config | sed -E 's#(A ).*#\1<redacted>#' | head -10`,
    'grep -n "a > b" README.md',
    String.raw`git log --format='%h <%an>'`,
  ];
  for (const command of commands) {
    assert.deepEqual(shellWriteIntent(command), { writes: false, paths: [] }, command);
  }
});

test('keeps real redirects after quoted arguments and with quoted targets', () => {
  const cases = [
    ['echo hi > "my file.txt"', ['my file.txt']],
    ["echo 'some text' > out.txt", ['out.txt']],
    ['echo hi >> log.txt', ['log.txt']],
    ['cmd 2> err.txt', ['err.txt']],
    ['echo hi >out.txt', ['out.txt']],
  ];
  for (const [command, paths] of cases) {
    assert.deepEqual(shellWriteIntent(command), { writes: true, paths }, command);
  }
});

test('does not hide a sed target after its quoted expression', () => {
  assert.deepEqual(shellWriteIntent("sed -i 's#a#b#' README.md"), {
    writes: true,
    paths: ['README.md'],
  });
});

test('keeps conservative write intent for an unbalanced quote', () => {
  assert.deepEqual(shellWriteIntent("echo 'unfinished > out.txt"), {
    writes: true,
    paths: ['out.txt'],
  });
});

test('does not report targets beginning with unresolved shell substitutions', () => {
  for (const target of ['$SP/finding.md', '%SP%/finding.md', '`resolve-path`/finding.md']) {
    assert.deepEqual(shellWriteIntent(`printf changed > "${target}"`), {
      writes: true,
      paths: [],
    }, target);
  }
});

test('a comparison operator inside code is not a redirection target', () => {
  // `>` the operator and `>` the redirect are indistinguishable to the pattern, so the guard
  // refuses to name any candidate carrying a character a file name cannot hold (2026-08-23).
  const command = String.raw`node -e "const i=2;console.log(i>0?'yes':'no')"`;
  assert.deepEqual(shellWriteIntent(command).paths, []);
  // `|` is deliberately absent: in `printf x > x|y.txt` the shell itself ends the target at the
  // pipe, so naming `x` there is correct rather than a false positive.
  for (const target of ['out?.txt', 'a<b.txt', 'star*.txt']) {
    assert.deepEqual(shellWriteIntent(`printf x > ${target}`).paths, [], target);
  }
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

test('a redirect target takes precedence over path-like text in a heredoc body', () => {
  const command = "python - > '/outside/finding.md' <<'PY'\nprint('CHANGELOG.md', '`')\nPY";
  assert.deepEqual(shellWriteIntent(command), {
    writes: true,
    paths: ['/outside/finding.md'],
  });
});

test('commands after a heredoc body are still examined', () => {
  // Reading only the opening line hid every command after the closing marker: a live probe on
  // 2026-08-23 appended to a tracked file this way while a run held the repository.
  const command = [
    "cat > /tmp/outside.md <<'EOF'",
    'text',
    'EOF',
    'echo broken >> README.md',
  ].join('\n');
  assert.deepEqual(shellWriteIntent(command), {
    writes: true,
    paths: ['/tmp/outside.md', 'README.md'],
  });
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
