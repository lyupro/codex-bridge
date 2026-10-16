/** Plan_80 E14 / D2: resume notes must never masquerade as frozen run inputs. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeTempTree } from '../temp-tree.mjs';
import { resumeBodyHeading } from '../../src/home/lib/runner/task-file.mjs';
import { ORDER_RULES, orderRuleMessage } from '../../src/home/lib/order-rules.mjs';

const ARGS = new URL('../../src/home/lib/runner/args.mjs', import.meta.url).href;
const INPUT = new URL('../../src/home/lib/runner/task-input.mjs', import.meta.url).href;
const PREFLIGHT = new URL('../../src/home/lib/runner/preflight.mjs', import.meta.url).href;
const NOTE = 'Continue the failed run with its frozen inputs.';

function run({ agent = 'codex-scout', grant = 'resume', body = NOTE, stdin = false, mode = 'settle',
  noWait = false } = {}) {
  const root = makeTempTree('resume-task-body-');
  const taskFile = path.join(root, 'task.md');
  const text = `repository: ${root}\norder id: resume-body\n` +
    (agent === 'codex-advisor' ? 'phase: scope\n' : '') +
    `${grant}: failed-run — continue the same pass\n\n${body}\n`;
  if (!stdin) fs.writeFileSync(taskFile, text, 'utf8');
  const opts = { agent, noWait, ...(stdin ? {} : { 'task-file': taskFile }) };
  const script = [
    `import { readTaskDocument } from ${JSON.stringify(ARGS)};`,
    `import { settleTaskInput } from ${JSON.stringify(INPUT)};`,
    `import { taskPreflight } from ${JSON.stringify(PREFLIGHT)};`,
    `const opts = ${JSON.stringify(opts)};`,
    'try {',
    `  const mode = ${JSON.stringify(mode)};`,
    '  const document = mode === "settle" ? settleTaskInput(opts) : readTaskDocument(opts);',
    '  const preflight = mode === "preflight" ? taskPreflight({',
    '    agent: opts.agent, taskText: document.task, header: document.header, resolution: {},',
    '  }) : null;',
    '  console.log(JSON.stringify({ document, opts, preflight }));',
    '} catch (error) {',
    '  console.error(error.message);',
    '  process.exitCode = error.exitCode ?? 1;',
    '}',
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root, encoding: 'utf8', input: stdin ? text : '',
  });
  return { ...result, taskFile };
}

function accepted(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function refused(result, rule, values) {
  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.ok(result.stderr.includes(orderRuleMessage(rule, values)), result.stderr);
  assert.equal(result.stdout, '');
}

test('resume-task-body has the contracted rule, data and bounded message', () => {
  const entry = ORDER_RULES['resume-task-body'];
  assert.equal(entry.topic, 'order');
  assert.deepEqual(entry.data, ['heading']);
  assert.equal(entry.rule,
    'Under a resume grant, write the task body as a plain note: the resumed run reuses the ' +
    'frozen questions, options, paths and verification of the named run and never reads this body, ' +
    'so Questions, Options, Paths and Verify headings are refused.');
  assert.equal(orderRuleMessage('resume-task-body', { heading: 'Questions' }),
    '`resume:` task body has a "Questions" section: a resumed run reuses the frozen inputs of the ' +
    'named run and never reads this body; remove the section and keep a plain note ' +
    '(to change the task, use retry: or a new order id); no quota was spent.');
  const heading = 'Q'.repeat(61);
  const message = orderRuleMessage('resume-task-body', { heading });
  assert.ok(message.includes(`"${heading.slice(0, 60)}"`));
  assert.ok(!message.includes(heading));
});

test('resumeBodyHeading shares heading recognition and preserves the first heading spelling', () => {
  assert.equal(resumeBodyHeading('## Task\r\nNote\r\n   ####\tQuEsTiOnS ###\t\r\n# Paths'), 'QuEsTiOnS');
  assert.equal(resumeBodyHeading('###### VERIFY\ncommand'), 'VERIFY');
  assert.equal(resumeBodyHeading('## Task\nQuestions in prose\n## Details'), null);
  assert.equal(resumeBodyHeading('####### Options\n    # Paths\n##Questions\nText ## Verify'), null);
});

for (const agent of ['codex-scout', 'codex-review', 'codex-advisor']) {
  test(`${agent} resume accepts a plain audit note without new sections`, () => {
    const { document, opts } = accepted(run({ agent }));
    assert.equal(document.header.grant.kind, 'resume');
    assert.equal(document.task, NOTE);
    assert.equal(opts.continue, true);
    assert.equal(opts.questions, undefined);
    assert.equal(opts.verify, undefined);
  });

  for (const [section, heading] of [
    ['## Questions\n- Frozen question?', 'Questions'],
    ['### verify\nnode --version', 'verify'],
    ['## Options\n- first: One\n- second: Two', 'Options'],
    ['# Paths\n- src/file.mjs', 'Paths'],
  ]) {
    test(`${agent} resume refuses ${heading} before using the body`, () => {
      const result = run({ agent, body: `${NOTE}\n${section}`, mode: 'read' });
      refused(result, 'resume-task-body', { heading });
      assert.ok(result.stderr.includes(`${result.taskFile}: `), result.stderr);
    });
  }
}

test('resume refuses an empty Questions heading before the section parser', () => {
  const result = run({ body: '## Questions', mode: 'read' });
  refused(result, 'resume-task-body', { heading: 'Questions' });
  assert.doesNotMatch(result.stderr, /Questions section is empty/);
});

test('advisor resume plain note passes taskPreflight', () => {
  const { preflight } = accepted(run({ agent: 'codex-advisor', mode: 'preflight' }));
  assert.deepEqual(preflight, { refusal: null });
});

for (const grant of ['retry', 'continue']) {
  test(`advisor ${grant} plain note still requires Options`, () => {
    const { preflight } = accepted(run({ agent: 'codex-advisor', grant, mode: 'preflight' }));
    assert.ok(preflight.refusal.includes(orderRuleMessage('advisor-task-options', { violation: 'missing' })));
  });

  test(`scout ${grant} plain note still requires Questions`, () => {
    refused(run({ grant }), 'scout-questions', { violation: 'missing' });
  });

  test(`scout ${grant} still checks question context markers`, () => {
    const result = run({ grant, body: `${NOTE}\n## Questions\n- [Context-Only] Why?` });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /invalid context-only marker/);
  });

  test(`scout ${grant} still accepts its own Questions and Verify`, () => {
    const { opts } = accepted(run({ grant, body: `${NOTE}\n## Questions\n- Why?\n## Verify\nnode --version` }));
    assert.deepEqual(opts.questions, ['Why?']);
    assert.equal(opts.verify, 'node --version');
  });
}

for (const stdin of [false, true]) {
  test(`empty resume body is still required through ${stdin ? 'stdin' : 'task file'}`, () => {
    const result = run({ body: ' \t\n', stdin });
    refused(result, 'task-body-required', stdin ? { channel: 'stdin' }
      : { channel: 'task-file', taskFile: result.taskFile });
  });

  test(`resume still rejects --no-wait through ${stdin ? 'stdin' : 'task file'}`, () => {
    const result = run({ stdin, noWait: true });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /--no-wait cannot be combined with a `resume:` grant/);
  });
}

for (const [section, heading] of [
  ['## Questions', 'Questions'], ['### verify', 'verify'], ['## Options', 'Options'], ['# Paths', 'Paths'],
]) {
  test(`stdin resume refuses ${heading} before section parsing`, () => {
    refused(run({ stdin: true, body: `${NOTE}\n${section}`, mode: 'read' }), 'resume-task-body', { heading });
  });
}

test('stdin scout resume accepts a plain audit note', () => {
  const { document } = accepted(run({ stdin: true }));
  assert.equal(document.task, NOTE);
  assert.equal(document.header.grant.kind, 'resume');
});
