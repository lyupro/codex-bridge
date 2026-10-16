/** Plan_80 E13 O8: read-only resume grants must enter through the shared task header. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  RESUME_ORDER_INPUT, RETRY_ORDER_INPUT, orderLabelsFor, orderFromHeader, orderInputName,
} from '../src/home/lib/order-schema.mjs';
import { parseTaskHeader, taskHeaderRefusal } from '../src/home/lib/task-header.mjs';
import { renderRequiredInputSummary, parseDispatcherCall } from '../src/home/lib/dispatcher-call.mjs';
import { RULES } from '../src/home/lib/order-rules/header-grants.mjs';
import { orderRuleMessage } from '../src/home/lib/order-rules.mjs';

const run = '2026-10-16_140740_ow066-b2-resume-grant';
const reason = 'advise stalled after reading, continue its thread';
const readOnlyAgents = ['codex-scout', 'codex-review', 'codex-advisor'];
const grantLabels = ['continue', 'retry', 'resume'];

test('resume input owns the frozen same-thread contract and follows retry only for read-only agents', () => {
  assert.ok(Object.isFrozen(RESUME_ORDER_INPUT));
  assert.deepEqual(RESUME_ORDER_INPUT, {
    label: 'resume',
    explanation: 'The failed read-only run whose Codex thread this pass continues, followed by why the orchestrator pays for it. A resume continues that pass in the same thread with its frozen task, schema and profile; it does not authorize the next pass.',
    example: `${run} — ${reason}`,
    conditional: RETRY_ORDER_INPUT.conditional,
  });
  assert.equal(orderInputName('resume'), '`resume:`');
  for (const agent of readOnlyAgents) {
    const labels = orderLabelsFor(agent);
    const retryIndex = labels.findIndex(({ label }) => label === 'retry');
    assert.equal(labels[retryIndex + 1].label, 'resume', agent);
    assert.equal(labels.filter(({ label }) => label === 'resume').length, 1, agent);
    assert.equal(labels[retryIndex + 1].conditional, true, agent);
    assert.equal(labels[retryIndex + 1].required, false, agent);
  }
  assert.equal(orderLabelsFor('codex-build').some(({ label }) => label === 'resume'), false);
});

for (const agent of readOnlyAgents) {
  test(`${agent} parses resume into a grant without consuming it as an order value`, () => {
    const lines = ['order id: resume-label'];
    if (agent === 'codex-advisor') lines.push('phase: advise');
    const parsed = parseTaskHeader([...lines, `resume: ${run} — ${reason}`, '', 'Inspect the task.'].join('\n'));
    assert.deepEqual(parsed.problems, []);
    assert.equal(taskHeaderRefusal(parsed), null);
    assert.deepEqual(parsed.grant, { kind: 'resume', run, reason });
    assert.equal(parsed.body, '\nInspect the task.');
    const result = orderFromHeader(agent, parsed);
    assert.deepEqual(result.problems, []);
    assert.equal(result.order.has('resume'), false);
    assert.deepEqual([...result.order], lines.map((line) => line.split(': ')));
  });
}

test('a build resume header is refused by agent-accepted-labels at its source line', () => {
  const line = `resume: ${run} — ${reason}`;
  const parsed = parseTaskHeader(`order id: resume-label\nscope: src/existing.mjs\nadvice: mechanical\n${line}\n\nTask`);
  assert.deepEqual(parsed.problems, []);
  const result = orderFromHeader('codex-build', parsed);
  assert.deepEqual(result.problems, [{
    lineNo: 4, line,
    reason: orderRuleMessage('agent-accepted-labels', { label: 'resume', agent: 'codex-build' }),
  }]);
  assert.equal(result.order.has('resume'), false);
});

// E13 O8: authorization conflicts depend on label presence and physical order, even for bad values.
for (const first of grantLabels) {
  for (const second of grantLabels.filter((label) => label !== first)) {
    const third = grantLabels.find((label) => label !== first && label !== second);
    for (const labels of [[first, second], [first, second, third]]) {
      test(`${labels.join('/')} conflicts once on the second grant line with valid or invalid values`, () => {
        for (const value of [`${run} — ${reason}`, 'TODO']) {
          const lines = ['order id: resume-label', `${labels[0]}: ${value}`, 'slug: resume-label',
            ...labels.slice(1).map((label) => `${label}: ${value}`)];
          const parsed = parseTaskHeader(lines.join('\n'));
          const exclusive = parsed.problems.filter(({ reason: message }) =>
            message === orderRuleMessage('grant-label-exclusive'));
          assert.deepEqual(exclusive, [{ lineNo: 4, line: lines[3],
            reason: 'continue, retry and resume are mutually exclusive; keep exactly one grant label' }]);
          assert.equal(parsed.problems.length, value === 'TODO' ? labels.length + 1 : 1);
          assert.ok(taskHeaderRefusal(parsed));
        }
      });
    }
  }
}

test('duplicate grant labels do not move the exclusivity diagnostic from the second distinct label', () => {
  const parsed = parseTaskHeader(`resume: ${run} — ${reason}\nresume: ${run} — ${reason}\nretry: ${run} — ${reason}`);
  const exclusive = parsed.problems.filter(({ reason: message }) =>
    message === orderRuleMessage('grant-label-exclusive'));
  assert.equal(exclusive.length, 1);
  assert.equal(exclusive[0].lineNo, 3);
  assert.equal(parsed.problems.length, 2);
});

test('resume rejects placeholders, paths and incomplete grants exactly like retry', () => {
  for (const value of ['TODO', '<run> — why', 'TODO — why', 'X — TBD', 'X — <reason>',
    'a/b — why', 'a\\b — why', '/tmp/run — why', 'C:\\runs\\X — why',
    '. — why', '.. — why', 'X', 'X —']) {
    const resume = parseTaskHeader(`resume: ${value}`);
    const retry = parseTaskHeader(`retry: ${value}`);
    assert.equal(resume.grant, null, value);
    assert.equal(resume.problems.length, 1, value);
    assert.equal(resume.problems[0].reason, retry.problems[0].reason.replace(/^retry:/, 'resume:'), value);
    assert.match(resume.problems[0].reason, /bare run folder/);
  }
});

test('resume has the same separators and misplaced-label guards as retry', () => {
  for (const separator of [' — ', ' - ', ':']) {
    assert.deepEqual(parseTaskHeader(`resume: ${run}${separator}${reason}`).grant,
      { kind: 'resume', run, reason });
  }
  for (const text of [`Task\nresume: ${run} — ${reason}`, `**resume:** ${run} — ${reason}`]) {
    const parsed = parseTaskHeader(text);
    assert.equal(parsed.grant, null);
    assert.equal(parsed.problems.length, 1);
    assert.match(parsed.problems[0].reason, /resume/);
  }
});

test('required-input summaries mark resume conditional only for the three read-only agents', () => {
  for (const agent of readOnlyAgents) {
    const summary = renderRequiredInputSummary(agent);
    const conditional = summary.split('conditional labels: ')[1].split('; optional labels:')[0];
    assert.ok(conditional.includes('`resume` (when this pass continues or repeats a named run)'), agent);
    assert.ok(conditional.indexOf('`resume`') > conditional.indexOf('`retry`'), agent);
  }
  assert.doesNotMatch(renderRequiredInputSummary('codex-build'), /`resume`/);
});

test('resume remains header-only in dispatcher calls, including build calls', () => {
  for (const agent of [...readOnlyAgents, 'codex-build']) {
    const result = parseDispatcherCall(agent, `task file: C:/scratch/task.md\nresume: ${run} — ${reason}`);
    assert.equal(result.problems.length, 1, agent);
    assert.match(result.problems[0].reason, /moved to the task-file header/);
  }
});

test('grant rule guidance and the agent table document all three distinct grant meanings', () => {
  assert.equal(RULES['grant-label-exclusive'].rule,
    'Keep exactly one grant label: continue, retry and resume cannot appear together, even with invalid values.');
  assert.equal(RULES['grant-value-shape'].rule,
    'Give continue, retry or resume a bare run folder other than . or .. and a non-placeholder reason, ' +
    'separated by an em dash, hyphen or colon.');
  const guidance = fs.readFileSync(new URL('../src/home/guidance/order.md', import.meta.url), 'utf8');
  for (const agent of [...readOnlyAgents, 'codex-build']) {
    const row = guidance.split('\n').find((line) => line.startsWith(`| ${agent} |`));
    assert.equal(row.split('|')[3].trim(), agent === 'codex-build'
      ? '`continue`, `retry`' : '`continue`, `retry`, `resume`', agent);
  }
  assert.ok(guidance.includes('`continue` names the continued run; `retry` repeats a failed pass on a fresh thread; ' +
    '`resume` continues a failed read-only pass in its own Codex thread; neither `retry` nor `resume` authorizes the next pass.'));
});
