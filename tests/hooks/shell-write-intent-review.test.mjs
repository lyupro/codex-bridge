/** Guards scanner grammar regressions found by independent review 2026-09-17_131740_plan-57-d4-review. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shellWriteIntent } from '../../src/home/hooks/shell-write-intent.mjs';

test('comments cannot introduce commands or redirections', () => {
  for (const command of [
    'git status --short # (rm README.md)',
    '# rm README.md > ignored.txt',
    'git status;# touch README.md > ignored.txt',
    'git status &&# touch README.md > ignored.txt',
    'echo ok # "unterminated > ignored.txt',
  ]) assert.deepEqual(shellWriteIntent(command), { writes: false, paths: [] }, command);
  assert.deepEqual(shellWriteIntent('git status # rm ignored.txt\ntouch next.txt'), {
    writes: true, paths: ['next.txt'],
  });
});

test('hashes inside words, quotes and escapes stay literal', () => {
  const cases = [
    ['echo a#b > out.txt', ['out.txt']],
    ['touch "#file.txt"', ['#file.txt']],
    [String.raw`touch \#file.txt`, ['#file.txt']],
    ['touch ""#file.txt', ['#file.txt']],
  ];
  for (const [command, paths] of cases) {
    assert.deepEqual(shellWriteIntent(command), { writes: true, paths }, command);
  }
});

test('literal parentheses and substitution suffixes do not create command positions', () => {
  for (const command of [
    'args=(rm README.md)',
    'a(b rm README.md)',
    String.raw`printf '%s\n' $(printf prefix)"touch" README.md`,
    'echo $(printf prefix) rm README.md',
    'echo (printf prefix) rm README.md',
    'echo "(rm a.txt)"',
    String.raw`echo \(rm a.txt\)`,
    String.raw`echo \$(rm README.md)`,
    'echo ) rm README.md',
  ]) assert.deepEqual(shellWriteIntent(command), { writes: false, paths: [] }, command);
});

test('real subshells and substitutions retain separate inner commands and outer arguments', () => {
  const cases = [
    ['(rm a.txt)', ['a.txt']],
    ['( cd x && rm a.txt )', ['a.txt']],
    ['echo $(rm a.txt)', ['a.txt']],
    ["touch 'a(b).txt'", ['a(b).txt']],
    ['echo $(printf x $(rm nested.txt))', ['nested.txt']],
    ['touch $(printf prefix) outer.txt', ['outer.txt']],
    ['echo $(printf x) && rm after.txt', ['after.txt']],
  ];
  for (const [command, paths] of cases) {
    assert.deepEqual(shellWriteIntent(command), { writes: true, paths }, command);
  }
});

test('word values join quote fragments before classifying commands and paths', () => {
  const cases = [
    ['touch "file".txt', ['file.txt']],
    ["env 'X=1' cp a.txt b.txt", ['b.txt']],
    ["find . -exec touch /tmp/outside ';' -print", ['/tmp/outside']],
    ['t"ou"ch file.txt', ['file.txt']],
    ['e"nv" "X"=1 c"p" a.txt "b".txt', ['b.txt']],
    ['touch " semi;comma, "', [' semi;comma, ']],
    [String.raw`touch 'C:\work\file.txt'`, ['C:\\work\\file.txt']],
    [String.raw`touch 'my\ file.txt'`, ['my\\ file.txt']],
  ];
  for (const [command, paths] of cases) {
    assert.deepEqual(shellWriteIntent(command), { writes: true, paths }, command);
  }
});

test('path guards apply to word values while redirect unquoting stays independent', () => {
  for (const command of [
    'printf changed > "$SP/finding.md"',
    'touch "$SP"/finding.md',
    'touch "%SP%"/finding.md',
    "touch '`resolve-path`'/finding.md",
    'touch "bad?".txt',
    String.raw`touch 'bad"name.txt'`,
  ]) assert.deepEqual(shellWriteIntent(command), { writes: true, paths: [] }, command);
});

test('command lookup flags never launch their operands', () => {
  for (const command of [
    'command -v "rm" "touch"',
    'command -V "rm" "touch"',
    'command -p -v rm README.md',
    'env command -V rm README.md',
  ]) assert.deepEqual(shellWriteIntent(command), { writes: false, paths: [] }, command);
  assert.deepEqual(shellWriteIntent('command -p rm README.md'), {
    writes: true, paths: ['README.md'],
  });
});

test('unfinished quotes retain the original quote-blind escape rules', () => {
  assert.deepEqual(shellWriteIntent(String.raw`echo 'unfinished; touch a\$file.txt a\#file.txt`), {
    writes: true, paths: ['a\\$file.txt', 'a\\#file.txt'],
  });
});

test('leading redirects and descriptor operands preserve the command position', () => {
  const cases = [
    ['2>& 1 rm README.md', ['README.md']],
    ['&>/dev/null rm README.md', ['/dev/null', 'README.md']],
    ['&>>/dev/null rm README.md', ['/dev/null', 'README.md']],
    ['&> /dev/null rm README.md', ['/dev/null', 'README.md']],
    ['&>> /dev/null rm README.md', ['/dev/null', 'README.md']],
    ['>& 1 rm README.md', ['README.md']],
    ['<& 0 rm README.md', ['README.md']],
    ['12>& 1 rm README.md', ['README.md']],
    ['> out.txt rm README.md', ['out.txt', 'README.md']],
    ['2> err.txt rm README.md', ['err.txt', 'README.md']],
  ];
  for (const [command, paths] of cases) {
    assert.deepEqual(shellWriteIntent(command), { writes: true, paths }, command);
  }
});

test('an escaped redirect character does not consume the following real redirect', () => {
  assert.deepEqual(shellWriteIntent(String.raw`printf x \>>README.md`), {
    writes: true, paths: ['README.md'],
  });
});

test('deep find actions return an intent object without overflowing the call stack', () => {
  let intent;
  assert.doesNotThrow(() => {
    intent = shellWriteIntent('find -exec '.repeat(6000) + 'rm README.md');
  });
  assert.equal(typeof intent, 'object');
  assert.deepEqual(intent, { writes: true, paths: ['README.md'] });
});

test('deep subshell nesting uses an explicit stack', () => {
  assert.deepEqual(shellWriteIntent('('.repeat(6000) + 'rm README.md' + ')'.repeat(6000)), {
    writes: true, paths: ['README.md'],
  });
});

test('a case pattern hands the command position to the command after it', () => {
  // Found accepting D4c: making an unmatched `)` literal lost this write, which both the original
  // scanner and D4b reported.
  const cases = [
    ['case x in a) rm b.txt;; esac', ['b.txt']],
    ['case "$f" in *.tmp) rm "$f";; *) touch done.txt;; esac', ['done.txt']],
    ['case x in\n  a|b) cp one.txt two.txt;;\nesac', ['two.txt']],
  ];
  for (const [command, paths] of cases) {
    assert.deepEqual(shellWriteIntent(command), { writes: true, paths }, command);
  }
  assert.deepEqual(shellWriteIntent('case x in a) echo rm b.txt;; esac'), { writes: false, paths: [] });
});
