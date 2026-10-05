/** Guards task-document sections before a run folder or paid process can exist. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import { parseTaskDocument } from '../../src/home/lib/runner/task-file.mjs';
import { orderInvocation } from './order-invocation.mjs';
import { launcherProcessMocks } from './launcher-mocks.mjs';

const RUNNER = fileURLToPath(new URL('../../src/home/lib/run-codex.mjs', import.meta.url));

function fixture(t, text) {
  const root = makeTempTree('task-document-');
  const taskFile = path.join(root, 'task.md');
  fs.writeFileSync(taskFile, text);
  t.after(() => removeTempTree(root));
  return { root, taskFile };
}

function run(t, text, extra = [], questions) {
  const { root } = fixture(t, '');
  const { argv } = orderInvocation({
    agent: 'codex-scout',
    order: { repository: root, 'order id': 'task-document' },
    task: text, questions, dir: root,
  });
  const script = [
    "import childProcess from 'node:child_process';",
    "import { syncBuiltinESMExports } from 'node:module';",
    launcherProcessMocks({ worker: 'spawn', probe: 'marker' }),
    'syncBuiltinESMExports();',
    `const { runCodexCommand } = await import(${JSON.stringify(pathToFileURL(RUNNER).href)});`,
    `process.exitCode = await runCodexCommand(${JSON.stringify([...argv, ...extra])});`,
  ].join('\n');
  // raw argv: isolate the launcher with mocked probes and workers to prove section acceptance safely.
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CODEX_RUNS_ROOT: path.join(root, 'runs') },
  });
}

test('a headingless file stays whole as the task statement', () => {
  assert.deepEqual(parseTaskDocument('First line\n\n## Prose heading\nLast line\n'), {
    task: 'First line\n\n## Prose heading\nLast line',
    questions: [],
    verify: undefined,
  });
});

test('all three sections are parsed from one file', () => {
  assert.deepEqual(parseTaskDocument('## Task\nBuild it.\n## Questions\n- One?\n* Two?\n3. Three?\n## Verify\nnpm test\n'), {
    task: 'Build it.',
    questions: ['One?', 'Two?', 'Three?'],
    verify: 'npm test',
  });
});

test('a preamble before the first heading is kept in the task', () => {
  assert.equal(parseTaskDocument('Keep this.\n\n## Questions\n- Why?').task, 'Keep this.');
});

test('a heading level other than two hashes is recognised', () => {
  assert.deepEqual(parseTaskDocument('# Task\nDo it.\n#### Questions\n- How?\n###### Verify\nnpm test'), {
    task: 'Do it.',
    questions: ['How?'],
    verify: 'npm test',
  });
});

test('an unknown heading stays inside its section', () => {
  assert.equal(parseTaskDocument('## Task\nIntro\n### Details\nBody').task, 'Intro\n### Details\nBody');
});

test('a non-list line under Questions is refused', () => {
  assert.throws(() => parseTaskDocument('## Questions\nThis is not a list item'), /Questions section.*non-list line/);
});

test('two non-empty lines under Verify are refused', () => {
  assert.throws(() => parseTaskDocument('## Verify\nnpm test\nnpm run lint'), /Verify section.*one non-empty line/);
});

test('an empty section is refused', () => {
  assert.throws(() => parseTaskDocument('## Questions\n\n## Task\nDo it'), /Questions section is empty/);
  assert.throws(() => parseTaskDocument('## Verify\n\n## Task\nDo it'), /Verify section is empty/);
});

test('--question is a closed flag even with a Questions section', (t) => {
  // raw argv: Plan_63 D8 closes the former question channel before reading file sections.
  const result = run(t, '## Task\nDo it\n## Questions\n- From file?', ['--question', 'From flag?']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown flag --question/i);
});

test('--verify is a closed flag even with a Verify section', (t) => {
  // raw argv: Plan_63 D8 closes the former verification channel before reading file sections.
  const result = run(t, '## Task\nDo it\n## Questions\n- Why?\n## Verify\nnpm test', ['--verify', 'npm run lint']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown flag --verify/i);
});

test('a scout run with questions only in the file is accepted', (t) => {
  const result = run(t, 'Do it', [], ['Why?']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const line = result.stdout.split(/\r?\n/).find((part) => part.startsWith('RUN='));
  assert.ok(line, result.stdout);
  const dir = line.slice(4).split(' order-id=', 1)[0];
  assert.match(fs.readFileSync(path.join(dir, 'questions.json'), 'utf8'), /Why\?/);
  assert.doesNotMatch(result.stderr, /a sub-question is required for codex-scout/);
});

test('a scout run with questions in neither source is refused', (t) => {
  const result = run(t, 'Do it');
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /a sub-question is required for codex-scout/);
  assert.doesNotMatch(result.stdout, /RUN=|STARTED/);
});

// The first task file written against this format was refused: `## Constraints` after `## Verify`
// was read as a second verification command. A sibling heading ends the section it follows.
test('an unrecognised heading at the same level ends the section', () => {
  const parsed = parseTaskDocument(
    '# Task\nDo it\n\n## Questions\n- Why?\n\n## Verify\nnpm test\n\n## Constraints\nBudget 25 minutes.\n',
  );
  assert.equal(parsed.verify, 'npm test');
  assert.deepEqual(parsed.questions, ['Why?']);
  assert.match(parsed.task, /Budget 25 minutes\./);
});

// Only a sibling or shallower heading ends a section. A deeper one is still inside it, and inside
// Questions nothing but a list item is a question — so it is refused rather than swallowed.
test('an unrecognised heading deeper than the section is refused inside Questions', () => {
  assert.throws(
    () => parseTaskDocument('# Task\nDo it\n\n## Questions\n- Why?\n\n### Aside\n- And why not?\n'),
    /non-list line/,
  );
});
