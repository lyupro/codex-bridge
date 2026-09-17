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

test('prose inside a plain heredoc names no write target', () => {
  // The four commands the lock refused on 2026-09-06, all writing outside the repository or not
  // at all. The last one is the class the earlier three only hinted at: `header` was read where
  // heredoc() returned `shell`, so with a plain writer the body went through shell parsing, and
  // an ordinary English sentence containing a command name turned its next words into targets.
  const target = '/c/Users/operator/session/notes.md';
  const document = (body) => [
    `cat > ${target} << 'EOF'`,
    ...body,
    'EOF',
  ].join('\n');
  const bodies = [
    ['Put the audit under docs/audits/ inside the repository, not here.'],
    ['See checklist-draft.md for the wording of step three.'],
    ['Windows spells it C:\Users\operator\config.json in the message.'],
    ['- Do not touch the installer, the permission rules or anything about speed.'],
  ];
  for (const body of bodies) {
    assert.deepEqual(
      shellWriteIntent(document(body)),
      { writes: true, paths: [target] },
      body[0],
    );
  }
});

test('an interpreter heredoc still exposes commands after its closing marker', () => {
  // The tail was reachable only through the non-interpreter branch, which returned it under a
  // different field name than the caller read. Naming one field fixed both directions at once.
  const command = [
    "python - <<'PY'",
    "write('CHANGELOG.md', 'changed')",
    'PY',
    'echo broken >> README.md',
  ].join('\n');
  assert.deepEqual(shellWriteIntent(command), { writes: true, paths: ['README.md'] });
});

test('does not split quoted text into apparent writing commands', () => {
  // The 2026-09-16 awk refusal repeated the 2026-08-23 node -e, 2026-08-28 sed and
  // 2026-09-06 heredoc incidents: literal text was mistaken for shell syntax.
  const commands = [
    `awk '/^## Scope/{f=1} f; /Do not touch any file outside/{f=0}' "docs/task.md"`,
    "grep -E 'rm old|touch new' notes.md",
    "echo 'step one; touch nothing'",
    'echo "a && rm b"',
    String.raw`printf '%s\n' "x | tee y"`,
  ];
  for (const command of commands) {
    assert.deepEqual(shellWriteIntent(command), { writes: false, paths: [] }, command);
  }
});

test('keeps escaped shell characters literal and removes only their escape', () => {
  // Git Bash accepts shell escapes on Windows, whose ordinary path backslashes must survive.
  const found = shellWriteIntent(String.raw`find . -name '*.tmp' -exec rm {} \;`);
  assert.equal(found.writes, true);
  assert.ok(!found.paths.includes('\\'));
  assert.ok(!found.paths.includes(';'));
  assert.deepEqual(shellWriteIntent(String.raw`touch my\ file.txt`), {
    writes: true,
    paths: ['my file.txt'],
  });
});

test('treats inline interpreter code as text at the scanner boundary', () => {
  // Plan_57 D11: -c/-e strings are text here; worktree-witness.mjs catches writes afterwards.
  // bash -c "cd x; rm a.txt" used to match only by splitting inside quotes, while
  // bash -c "rm a.txt" never matched. That accidental coverage is not a parsing contract.
  for (const command of [
    'bash -c "rm a.txt"',
    'bash -c "cd x; rm a.txt"',
    "sh -c 'touch b.txt'",
    `node -e "require('fs').writeFileSync('x.txt','1')"`,
    `python -c "open('x.txt','w')"`,
  ]) {
    assert.deepEqual(shellWriteIntent(command), { writes: false, paths: [] }, command);
  }
});

test('keeps real command boundaries, redirects and Windows destination paths', () => {
  const cases = [
    ['sleep 1 & rm a.txt', ['a.txt']],
    ['cd d && rm a.txt', ['a.txt']],
    ['git status; touch b.txt', ['b.txt']],
    ['foo"bar baz" > out.txt', ['out.txt']],
    [String.raw`cp a.txt C:\work\b.txt`, ['C:\\work\\b.txt']],
    ['make 2>&1 | tee build.log', ['build.log']],
  ];
  for (const [command, paths] of cases) {
    assert.deepEqual(shellWriteIntent(command), { writes: true, paths }, command);
  }
});

test('keeps command boundaries conservative when a quote is unfinished', () => {
  // The malformed-input fallback must cover splitting and words as well as redirects.
  assert.equal(shellWriteIntent("echo 'step one; touch nothing").writes, true);
  assert.deepEqual(shellWriteIntent("echo 'step touch nothing"), { writes: true, paths: ['nothing'] });
});

test('keeps escaped separators, redirects and quotes out of shell syntax', () => {
  // A literal metacharacter must have the same meaning to all three consumers of the lexer.
  for (const command of [
    String.raw`echo a\;touch\ b.txt`,
    String.raw`echo a\|tee\ b.txt`,
    String.raw`echo a\&rm\ b.txt`,
    String.raw`echo a\>b.txt`,
    String.raw`echo \"a\>b.txt\"`,
    String.raw`echo \'a\>b.txt\'`,
    String.raw`echo "a\"; touch b.txt"`,
  ]) {
    assert.deepEqual(shellWriteIntent(command), { writes: false, paths: [] }, command);
  }
});

test('preserves escaped metacharacters in word values and ordinary Windows backslashes', () => {
  const cases = [
    [String.raw`touch a\;b.txt`, 'a;b.txt'],
    [String.raw`touch a\&b.txt`, 'a&b.txt'],
    [String.raw`touch a\(b\).txt`, 'a(b).txt'],
    [String.raw`touch it\'s.txt`, "it's.txt"],
    [String.raw`touch a\\b.txt`, 'a\\b.txt'],
    ['touch my\\\tfile.txt', 'my\tfile.txt'],
    [String.raw`touch C:\work\b.txt`, 'C:\\work\\b.txt'],
    [String.raw`touch 'my\ file.txt'`, 'my\\ file.txt'],
  ];
  for (const [command, path] of cases) {
    assert.deepEqual(shellWriteIntent(command), { writes: true, paths: [path] }, command);
  }
});

test('keeps adjacent quoted and unquoted fragments in a single word', () => {
  // D4a must not turn a word fragment into a command; command-position changes belong to D4b.
  for (const command of [
    'echo foo" touch "bar target.txt',
    'echo "prefix"touch target.txt',
    'echo "touch" target.txt',
    "echo 'rm' target.txt",
    'echo "line one\r\nrm a.txt & touch b.txt"',
  ]) {
    assert.deepEqual(shellWriteIntent(command), { writes: false, paths: [] }, command);
  }
  assert.deepEqual(shellWriteIntent('env touch target.txt'), { writes: true, paths: ['target.txt'] });
});

test('distinguishes background boundaries from ampersands belonging to operators', () => {
  const cases = [
    ['sleep 1&rm a.txt', ['a.txt']],
    ['false || touch b.txt', ['b.txt']],
    ['git status\r\ntouch b.txt', ['b.txt']],
    ['cp a.txt 2>&1 b.txt', ['b.txt']],
    ['cp a.txt >&2 b.txt', ['b.txt']],
    ['cp a.txt <&0 b.txt', ['b.txt']],
    ['cp a.txt &>log.txt b.txt', ['log.txt', 'b.txt']],
    ['make |&tee build.log', ['build.log']],
    [String.raw`echo \>&touch b.txt`, ['b.txt']],
    [String.raw`echo \|&touch b.txt`, ['b.txt']],
  ];
  for (const [command, paths] of cases) {
    assert.deepEqual(shellWriteIntent(command), { writes: true, paths }, command);
  }
});
