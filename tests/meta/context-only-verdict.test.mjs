/** Guards Plan_60 D1: handed startup context needs sources, and unread addresses remain failures. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collect } from '../../src/home/lib/write-meta.mjs';
import { allStartupContext, contextOnlyGap } from '../../src/home/lib/meta/context-only.mjs';
import { INSTRUCTIONS } from '../../src/home/lib/runner/prompts.mjs';
import { QUESTION_KIND } from '../../src/home/lib/runner/question-kind.mjs';
import { COMPLETED_COMMAND, makeRun } from './test-fixtures.mjs';

const noCommands = [
  { type: 'thread.started', thread_id: 'context-only' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'Analysis follows.' } },
];
const questions = [
  { id: 'Q1', text: 'What task was handed to this run?', kind: QUESTION_KIND.STARTUP_CONTEXT },
  { id: 'Q2', text: 'What instructions were handed to this run?', kind: QUESTION_KIND.STARTUP_CONTEXT },
];
const prose = 'The startup task supplied the requested outcome and its allowed file scope. '
  + 'The instructions supplied the response contract and verification requirements, so the run '
  + 'can describe these inputs directly from the context it received before any command executed.';
const scoutResult = {
  answer: 'The run received its task and instructions at startup. Those inputs define its scope and response.',
  answers: questions.map((question) => ({
    question_id: question.id, answer: prose, evidence: ['startup:task'],
  })),
  findings: [],
  unknowns: [],
  report_markdown: '# Startup context',
};
const noCommandReason = 'scout executed no command, so no answer rests on reading the code; '
  + 'check stderr.log for sandbox refusals before changing the order';

function verdict(extra = {}) {
  const dir = makeRun({
    args: ['exec', '--json'], events: noCommands, questions, result: scoutResult, ...extra,
  });
  return collect(dir, 'codex-scout', 0).meta;
}

function withEvidence(evidence) {
  return {
    ...scoutResult,
    answers: scoutResult.answers.map((answer, index) => index === 0 ? { ...answer, evidence } : answer),
  };
}

test('all marked questions with startup references and prose pass without commands', () => {
  const meta = verdict();
  assert.equal(meta.status, 'OK', meta.reason);
});

test('an answer citing an unread repository coordinate fails even with a startup reference', () => {
  const coordinate = 'src/home/lib/runner/launcher.mjs:52';
  const meta = verdict({ result: withEvidence(['startup:task', coordinate]) });
  assert.equal(meta.status, 'FAIL');
  assert.equal(meta.reason,
    `scout cited ${coordinate} without executing a command: an address nobody read`);
});

test('a finding citing an unread repository coordinate fails', () => {
  const meta = verdict({
    result: { ...scoutResult, findings: [{ where: 'cli/install.mjs:10', fact: 'An unread claim.' }] },
  });
  assert.equal(meta.status, 'FAIL');
  assert.equal(meta.reason,
    'scout cited cli/install.mjs:10 without executing a command: an address nobody read');
});

test('marked questions with plain sentence evidence fail naming the unsourced question', () => {
  const meta = verdict({ result: withEvidence(['The startup task was supplied in the prompt.']) });
  assert.equal(meta.status, 'FAIL');
  assert.equal(meta.reason,
    'responses to startup-context questions without a startup:<source> reference: Q1');
});

test('mixed questions without commands retain the existing no-command reason', () => {
  const meta = verdict({
    questions: [questions[0], { ...questions[1], kind: QUESTION_KIND.CODE_REQUIRED }],
  });
  assert.equal(meta.status, 'FAIL');
  assert.equal(meta.reason, noCommandReason);
});

test('archived questions without kind retain the existing no-command reason', () => {
  const meta = verdict({ questions: questions.map(({ id, text }) => ({ id, text })) });
  assert.equal(meta.status, 'FAIL');
  assert.equal(meta.reason, noCommandReason);
});

test('a completed command allows repository coordinates alongside startup references', () => {
  const meta = verdict({
    events: [...noCommands, COMPLETED_COMMAND],
    result: withEvidence(['src/home/lib/runner/launcher.mjs:52', 'startup:task']),
  });
  assert.equal(meta.status, 'OK', meta.reason);
});

test('without an events stream repository coordinates do not trigger the unread-address rule', () => {
  const dir = makeRun({
    questions, result: withEvidence(['startup:task', 'src/home/lib/runner/launcher.mjs:52']),
  });
  const { meta } = collect(dir, 'codex-scout', 0);
  assert.equal(meta.status, 'OK', meta.reason);
});

test('scout instructions render the startup rule only when a question has startup-context kind', () => {
  const plain = questions.map((question) => ({ ...question, kind: QUESTION_KIND.CODE_REQUIRED }));
  const archived = questions.map(({ id, text }) => ({ id, text }));
  const unmarked = INSTRUCTIONS['codex-scout']({}, null, plain);
  const marked = INSTRUCTIONS['codex-scout']({}, null, [plain[0], questions[1]]);
  assert.ok(!unmarked.includes('startup:'));
  assert.equal(INSTRUCTIONS['codex-scout']({}, null, archived), unmarked);
  assert.ok(!INSTRUCTIONS['codex-scout']({}).includes('startup:'));
  assert.match(marked, /marked \[context-only\] asks about what this run was handed at startup/);
  assert.match(marked, /task, instructions, schema, environment/);
  assert.match(marked, /cite evidence as `startup:<source>`/);
  assert.match(marked, /never cite a repository `path:line` you did not read\n  with a command/);
  assert.ok(marked.includes('that fails the run.'));
  assert.equal(marked.replace(/- A sub-question marked \[context-only\][\s\S]*?fails the run\.\n/, ''), unmarked);
  assert.ok(unmarked.includes('support every fact about the code with a `path:line` reference'));
});

test('only a non-empty array with every item marked receives the command exemption', () => {
  assert.equal(allStartupContext(questions), true);
  for (const input of [undefined, null, {}, [], [null], [questions[0], null],
    [{ id: 'Q1' }], [questions[0], { kind: QUESTION_KIND.CODE_REQUIRED }]]) {
    assert.equal(allStartupContext(input), false);
  }
  for (const input of [null, {}, [], [questions[0], null]]) {
    assert.equal(verdict({ questions: input }).reason, noCommandReason);
  }
});

test('coverage still precedes startup source and coordinate checks', () => {
  const missing = verdict({ result: { ...scoutResult, answers: [] } });
  assert.equal(missing.status, 'FAIL');
  assert.equal(missing.reason, 'scout did not answer 2 sub-questions: Q1, Q2');
  const thin = verdict({
    result: { ...scoutResult, answers: scoutResult.answers.map((answer) => ({ ...answer, answer: 'Short.' })) },
  });
  assert.equal(thin.reason, 'response to Q1, Q2 contains coordinates without analysis');
  const empty = verdict({ result: withEvidence([]) });
  assert.equal(empty.reason, 'responses without a single code reference: Q1');
});

test('startup reference matching ignores id case and whitespace, and the first answer wins', () => {
  const result = {
    answers: [
      { question_id: ' q1 ', evidence: ['startup:   task'] },
      { question_id: 'Q1', evidence: [] },
      { question_id: 'q2', evidence: ['startup:AGENTS.md instructions'] },
    ],
  };
  assert.equal(contextOnlyGap({ questions, result, commandsExecuted: 0 }), null);
  result.answers.reverse();
  assert.equal(contextOnlyGap({ questions, result, commandsExecuted: 0 }),
    'responses to startup-context questions without a startup:<source> reference: Q1');
});

test('empty startup sources fail and multiple unsourced question ids retain question order', () => {
  const ordered = [questions[0], { ...questions[1], id: 'Q3' }];
  const result = { answers: [
    { question_id: 'Q1', evidence: ['startup:   '] },
    { question_id: 'Q3', evidence: ['A source is required.'] },
  ] };
  assert.equal(contextOnlyGap({ questions: ordered, result, commandsExecuted: 1 }),
    'responses to startup-context questions without a startup:<source> reference: Q1, Q3');
});

test('every answer is checked for unread coordinates, including duplicate answers', () => {
  const result = {
    ...scoutResult,
    answers: [...scoutResult.answers, { question_id: 'q1', evidence: ['First ref: extra.mjs:8 then other.js:9'] }],
    findings: [{ where: 'finding.mjs:4' }],
  };
  assert.equal(verdict({ result }).reason,
    'scout cited extra.mjs:8 without executing a command: an address nobody read');
});

test('startup-prefixed sources are exempt from coordinate matching', () => {
  const meta = verdict({
    result: { ...withEvidence(['startup:task cites source.mjs:42']), findings: [{ where: 'startup:task.mjs:2' }] },
  });
  assert.equal(meta.status, 'OK', meta.reason);
});

test('unknown command counts skip coordinate checking and long coordinates are bounded', () => {
  const coordinate = `${'a'.repeat(70)}.mjs:12`;
  const result = withEvidence(['startup:task', coordinate]);
  for (const commandsExecuted of [null, undefined]) {
    assert.equal(contextOnlyGap({ questions, result, commandsExecuted }), null);
  }
  assert.equal(contextOnlyGap({ questions, result, commandsExecuted: 0 }),
    `scout cited ${coordinate.slice(0, 60)} without executing a command: an address nobody read`);
});
