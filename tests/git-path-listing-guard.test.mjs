/**
 * Plan_73 B6: path-listing git arguments belong only in runner/git-paths.mjs.
 * On 2026-09-30 git's quoted/octal-escaped Cyrillic names broke scope and verdict
 * checks. Centralized -z decoding prevents that incident from recurring; only
 * the exact human-readable artifact calls and reviewer labels are exempt.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceFiles, tokensWithoutComments, unquote } from './child-process-scan.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const owner = 'src/home/lib/runner/git-paths.mjs';
const listingArguments = new Set([
  'ls-files', 'ls-tree', 'diff-tree', '--name-only', '--name-status',
  '--numstat', '--porcelain', '--raw', '--stat',
]);

// File + literal + complete line, not a file-wide or core.quotepath exception.
const allowedSites = [
  {
    file: 'src/home/lib/runner/launcher.mjs', literal: '--porcelain',
    line: "fs.writeFileSync(path.join(runDir, 'git-before.txt'), git(repoRoot, ['-c', 'core.quotepath=false', 'status', '--porcelain']).stdout || '');",
    reason: 'Plan_73 D1: git-before.txt is human-readable only (docs/artifact-formats.md).',
  },
  {
    file: 'src/home/lib/runner/worker.mjs', literal: '--porcelain',
    line: "fs.writeFileSync(path.join(runDir, 'git-after.txt'), git(repoRoot, ['-c', 'core.quotepath=false', 'status', '--porcelain']).stdout || '');",
    reason: 'Plan_73 D1: git-after.txt is human-readable only (docs/artifact-formats.md).',
  },
  {
    file: 'src/home/lib/runner/worker.mjs', literal: '--stat',
    line: "fs.writeFileSync(path.join(runDir, 'diff.stat'), git(repoRoot, ['-c', 'core.quotepath=false', 'diff', '--stat']).stdout || '');",
    reason: 'Plan_73 D1: diff.stat is human-readable only (docs/artifact-formats.md).',
  },
  {
    file: 'src/home/lib/runner/git-state.mjs', literal: 'git status --porcelain && git diff HEAD',
    line: "diffCommand: 'git status --porcelain && git diff HEAD',",
    reason: 'diffCommand is a reviewer label, never executed.',
  },
  {
    file: 'src/home/lib/runner/git-state.mjs', literal: 'git diff ${base}...HEAD',
    line: 'diffCommand: `git diff ${base}...HEAD`,',
    reason: 'diffCommand is a reviewer label, never executed.',
  },
  {
    file: 'src/home/lib/runner/git-state.mjs', literal: 'git show ${sha}',
    line: 'diffCommand: `git show ${sha}`,',
    reason: 'diffCommand is a reviewer label, never executed.',
  },
];

function withoutComments(source) {
  // Match strings first, as in the shared scanner, preserving comment newlines
  // and offsets so diagnostics still point at the original source line.
  return source.replace(/(["'`])(?:\\[\s\S]|(?!\1)[^\\])*?\1|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g,
    (token) => token.startsWith('//') || token.startsWith('/*')
      ? token.replace(/[^\r\n]/g, ' ') : token);
}

function offenders(files) {
  const found = [];
  for (const { file, source } of files) {
    if (file === owner) continue;
    const clean = withoutComments(source);
    const lines = clean.split(/\r?\n/);
    const usedSites = new Set();
    let cursor = 0;
    for (const token of tokensWithoutComments(clean)) {
      const offset = clean.indexOf(token, cursor);
      cursor = offset + token.length;
      if (!/^["'`]/.test(token)) continue;
      const literal = unquote(token);
      if (!listingArguments.has(literal)) continue;
      const line = clean.slice(0, offset).split('\n').length;
      const site = allowedSites.find((allowed) => allowed.file === file
        && allowed.literal === literal && allowed.line === lines[line - 1].trim());
      // A copied display call is a new site, even if its text is identical.
      if (site && !usedSites.has(site)) {
        usedSites.add(site);
        continue;
      }
      found.push({ file, line, literal });
    }
  }
  return found.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

function assertCentralized(files) {
  const found = offenders(files);
  assert.deepEqual(found, [], found.map(({ file, line, literal }) =>
    `${file}:${line}: ${literal}: add the listing to git-paths.mjs`).join('\n'));
}

const sources = ['src', 'cli', 'bin'].flatMap((directory) => sourceFiles(path.join(root, directory)))
  .filter((file) => file.endsWith('.mjs'))
  .map((file) => ({
    file: path.relative(root, file).replaceAll(path.sep, '/'),
    source: fs.readFileSync(file, 'utf8'),
  }));

test('every path-listing git literal in src, cli and bin is centralized', () => {
  for (const directory of ['src', 'cli', 'bin']) {
    assert.ok(sources.some(({ file }) => file.startsWith(`${directory}/`)), directory);
  }
  assertCentralized(sources);
});

test('the guard reports direct, helper, bound-array and unconfigured display plants', () => {
  // A temporary source tree in memory follows the existing no-shell guard's
  // plants: no fixture files or production sources are changed to exercise it.
  const tree = [
    { file: 'src/direct.mjs', source: "// ignored header\nspawnSync('git', ['ls-files']);" },
    { file: 'cli/helper.mjs', source: "/* ignored\ncomment */\ngit(repo, ['diff', '--name-only', x]);" },
    { file: 'bin/bound.mjs', source: "const args = ['status', '--porcelain'];\nspawnSync('git', args);" },
    {
      file: 'src/home/lib/runner/worker.mjs',
      source: "\nfs.writeFileSync(path.join(runDir, 'diff.stat'), git(repoRoot, ['diff', '--stat']).stdout || '');",
    },
  ];
  const expected = [
    { file: 'bin/bound.mjs', line: 1, literal: '--porcelain' },
    { file: 'cli/helper.mjs', line: 3, literal: '--name-only' },
    { file: 'src/direct.mjs', line: 2, literal: 'ls-files' },
    { file: 'src/home/lib/runner/worker.mjs', line: 2, literal: '--stat' },
  ];
  assert.deepEqual(offenders(tree), expected);
  assert.throws(() => assertCentralized(tree), (error) => {
    assert.equal(error.code, 'ERR_ASSERTION');
    for (const { file, line } of expected) assert.ok(error.message.includes(`${file}:${line}:`));
    assert.ok(error.message.includes('add the listing to git-paths.mjs'));
    return true;
  });
});

test('every listed argument is rejected irrespective of the calling API', () => {
  for (const literal of listingArguments) {
    for (const quote of ["'", '"', '`']) {
      const file = 'cli/listing.mjs';
      assert.deepEqual(offenders([{ file, source: `const args = [${quote}${literal}${quote}];` }]),
        [{ file, line: 1, literal }]);
    }
  }
});

test('the owner, comments and exact display sites are permitted', () => {
  assert.deepEqual(offenders([{ file: owner, source: "const args = ['ls-files', '--numstat'];" }]), []);
  assert.deepEqual(offenders([{
    file: 'cli/comments.mjs',
    source: "// 'ls-files'\n/* '--name-only'\n'--stat' */\nconst text = \"quoted '--raw' and https://example.test\";",
  }]), []);
  for (const site of allowedSites) {
    assert.ok(site.reason);
    assert.deepEqual(offenders([{ file: site.file, source: site.line }]), [], site.reason);
  }
});

test('display exceptions do not permit neighboring, moved or altered calls', () => {
  for (const site of allowedSites.filter(({ literal }) => listingArguments.has(literal))) {
    const neighbor = `git(repoRoot, ['${site.literal}']);`;
    assert.deepEqual(offenders([{ file: site.file, source: `${site.line}\n${neighbor}` }]),
      [{ file: site.file, line: 2, literal: site.literal }]);
    assert.deepEqual(offenders([{ file: site.file, source: `${site.line}\n${site.line}` }]),
      [{ file: site.file, line: 2, literal: site.literal }]);
    for (const source of [
      site.line.replace("'-c', 'core.quotepath=false', ", ''),
      site.line.replace('core.quotepath=false', 'core.quotepath=true'),
      site.line.replace('runDir', 'otherDir'),
    ]) {
      assert.deepEqual(offenders([{ file: site.file, source }]),
        [{ file: site.file, line: 1, literal: site.literal }]);
    }
    assert.deepEqual(offenders([{ file: 'cli/moved.mjs', source: site.line }]),
      [{ file: 'cli/moved.mjs', line: 1, literal: site.literal }]);
  }
});
