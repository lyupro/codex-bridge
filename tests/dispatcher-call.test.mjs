/** Guards Plan_76 D1 against the 2026-10-04 label aliasing and repository-prose incidents. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDispatcherCall, renderCallRefusal } from '../src/home/lib/dispatcher-call.mjs';
import {
  OPTIONAL_INPUTS,
  REQUIRED_INPUTS,
  callInputsFor,
  requiredInputsFor,
} from '../src/home/lib/required-inputs.mjs';
import { SHELL_UNSAFE_SEQUENCES } from '../src/home/lib/shell-unsafe.mjs';

const agents = Object.keys(REQUIRED_INPUTS);
const values = { 'order id': 'a1', 'task file': 'C:/scratch/task.md', scope: 'src/**', phase: 'scope' };

function minimalCall(agentType, overrides = {}) {
  return requiredInputsFor(agentType).filter((entry) => !entry.conditional)
    .map((entry) => `${entry.label}: ${overrides[entry.label] ?? values[entry.label]}`).join('\n');
}

function lineProblem(result, line, text, reason) {
  assert.deepEqual(result.problems.find((problem) => problem.line === line), { line, text, reason });
}

for (const agent of agents) {
  test(`${agent} accepts its minimal required call without demanding conditional or optional labels`, () => {
    const result = parseDispatcherCall(agent, minimalCall(agent));
    assert.ok(result.inputs instanceof Map);
    assert.deepEqual(result.problems, []);
    assert.deepEqual([...result.inputs], requiredInputsFor(agent).filter((entry) => !entry.conditional)
      .map((entry) => [entry.label, values[entry.label]]));
  });
}

test('blank lines, CRLF, tabs, outer whitespace and any input order are accepted', () => {
  for (const agent of agents) {
    const lines = minimalCall(agent).split('\n').reverse().map((line) => ` \t${line.replace(': ', ':\t')} \t`);
    const result = parseDispatcherCall(agent, `\r\n \t\r\n${lines.join('\r\n\r\n')}\r\n`);
    assert.deepEqual(result.problems, []);
    assert.equal(result.inputs.get('order id'), 'a1');
    assert.equal(result.inputs.get('task file'), values['task file']);
  }
});

test('all existing required and conditional entries name their exact runner flag', () => {
  const flags = {
    'order id': '--order-id', scope: '--scope', 'task file': '--task-file', phase: '--phase',
    continue: '--continue', retry: '--continue',
  };
  for (const entries of Object.values(REQUIRED_INPUTS)) {
    for (const entry of entries) assert.equal(entry.flag, flags[entry.label]);
  }
});

test('the frozen optional registry records agent ownership, metadata and exact runner flags', () => {
  assert.equal(Object.isFrozen(OPTIONAL_INPUTS), true);
  assert.deepEqual(OPTIONAL_INPUTS.map(({ label, agents: owners, flag }) => [label, owners, flag]), [
    ['repository', agents, '--repo'],
    ['scope new', ['codex-build'], '--scope-new'],
    ['slug', agents, '--slug'],
    ['effort', agents, '--effort'],
    ['changeset', ['codex-review'], '--changeset'],
  ]);
  for (const entry of OPTIONAL_INPUTS) {
    assert.equal(Object.isFrozen(entry), true);
    assert.equal(Object.isFrozen(entry.agents), true);
    assert.deepEqual(Object.keys(entry).sort(), ['agents', 'example', 'explanation', 'flag', 'label', 'source']);
    for (const key of ['source', 'explanation', 'example']) assert.ok(entry[key].trim().length > 0);
  }
  const changeset = OPTIONAL_INPUTS.find((entry) => entry.label === 'changeset');
  for (const value of ['uncommitted', 'base:<branch>', 'commit:<sha>']) {
    assert.ok(changeset.explanation.includes(value));
  }
});

test('callInputsFor appends only agent-owned optional entries to the unchanged required entries', () => {
  for (const agent of agents) {
    const required = requiredInputsFor(agent);
    const entries = callInputsFor(agent);
    assert.deepEqual(entries.slice(0, required.length), required);
    entries.slice(0, required.length).forEach((entry, index) => assert.equal(entry, required[index]));
    const optional = OPTIONAL_INPUTS.filter((entry) => entry.agents.includes(agent));
    assert.deepEqual(entries.slice(required.length), optional.map((entry) => ({ ...entry, optional: true })));
    for (const entry of entries) {
      assert.ok(typeof entry.flag === 'string' && entry.flag.trim().length > 0, `${agent}: ${entry.label}`);
    }
    assert.equal(new Set(entries.map((entry) => entry.label)).size, entries.length);
  }
  for (const unknown of ['codex-unknown', 'toString', 'constructor', '__proto__']) {
    assert.deepEqual(callInputsFor(unknown), []);
  }
});

test('every optional example parses for every owning agent', () => {
  for (const entry of OPTIONAL_INPUTS) {
    for (const agent of entry.agents) {
      const result = parseDispatcherCall(agent, `${minimalCall(agent)}\n${entry.label}: ${entry.example}`);
      assert.deepEqual(result.problems, []);
      assert.equal(result.inputs.get(entry.label), entry.example);
    }
  }
});

test('scope-new above or below scope is diagnosed without stealing the scope value', () => {
  const required = ['order id: a1', 'task file: C:/scratch/task.md'];
  for (const lines of [['scope-new: src/', 'scope: tests/**'], ['scope: tests/**', 'scope-new: src/']]) {
    const result = parseDispatcherCall('codex-build', [...lines, ...required].join('\n'));
    assert.equal(result.inputs.get('scope'), 'tests/**');
    assert.equal(result.inputs.has('scope new'), false);
    assert.deepEqual(result.problems, [{
      line: lines.indexOf('scope-new: src/') + 1,
      text: 'scope-new: src/',
      reason: 'write the label exactly as `scope new:`',
    }]);
  }
});

test('noncanonical labels are diagnosed with their exact registry spelling', () => {
  const cases = [
    ['order-id: a1', 'order id'],
    ['- **order id:** a1', 'order id'],
    ['* `order id`: a1', 'order id'],
    ['__order_id__: a1', 'order id'],
    ['ORDER ID: a1', 'order id'],
    ['order  id: a1', 'order id'],
    ['order\tid: a1', 'order id'],
    ['order id : a1', 'order id'],
    ['order id:a1', 'order id'],
    ['order id:\u00a0a1', 'order id'],
  ];
  for (const [text, label] of cases) {
    const result = parseDispatcherCall('codex-scout', `${text}\ntask file: C:/scratch/task.md`);
    lineProblem(result, 1, text, `write the label exactly as \`${label}:\``);
    assert.equal(result.inputs.has(label), false);
    assert.ok(result.problems.some((problem) => problem.line === null));
  }
});

test('repository prose, flags, alternate separators and free text are refused as free text', () => {
  const cases = [
    'Repository root: C:/x', '--order-id a1', 'Please implement the task',
    'order id = a1', 'order id — a1', 'order id - a1', 'unknown: a1',
  ];
  for (const text of cases) {
    const result = parseDispatcherCall('codex-scout', `${minimalCall('codex-scout')}\n${text}`);
    assert.deepEqual(result.problems, [{
      line: 3, text, reason: 'not a `label: value` line; free text belongs in the task file',
    }]);
  }
});

test('every known label owned only by other agents is refused with an agent-specific reason', () => {
  const labels = new Set([...Object.values(REQUIRED_INPUTS).flat(), ...OPTIONAL_INPUTS]
    .map((entry) => entry.label));
  for (const agent of agents) {
    const accepted = new Set(callInputsFor(agent).map((entry) => entry.label));
    for (const label of labels) {
      if (accepted.has(label)) continue;
      const result = parseDispatcherCall(agent, `${minimalCall(agent)}\n${label}: src/`);
      assert.equal(result.inputs.has(label), false);
      assert.equal(result.problems.length, 1);
      assert.equal(result.problems[0].reason, `label \`${label}\` is not accepted by \`${agent}\``);
    }
  }
  const result = parseDispatcherCall('codex-scout', `${minimalCall('codex-scout')}\nscope-new: src/`);
  assert.equal(result.problems[0].reason, 'label `scope new` is not accepted by `codex-scout`');
});

test('changeset values with embedded colons are accepted only by codex-review', () => {
  for (const value of ['uncommitted', 'base:main', 'commit:abcdef1']) {
    for (const agent of agents) {
      const result = parseDispatcherCall(agent, `${minimalCall(agent)}\nchangeset: ${value}`);
      if (agent === 'codex-review') {
        assert.deepEqual(result.problems, []);
        assert.equal(result.inputs.get('changeset'), value);
      } else {
        assert.equal(result.inputs.has('changeset'), false);
        assert.equal(result.problems[0].reason, `label \`changeset\` is not accepted by \`${agent}\``);
      }
    }
  }
});

test('identical or different duplicates are refused and the first accepted value stays', () => {
  for (const value of ['a1', 'a2']) {
    const text = `order id: ${value}`;
    const result = parseDispatcherCall('codex-scout', `\n${minimalCall('codex-scout')}\n${text}`);
    assert.equal(result.inputs.get('order id'), 'a1');
    assert.deepEqual(result.problems, [{
      line: 4, text, reason: 'label `order id` is given twice (line 2 and line 4)',
    }]);
  }
});

test('an invalid earlier spelling does not occupy the canonical label', () => {
  const result = parseDispatcherCall('codex-scout', `order-id: wrong\n${minimalCall('codex-scout')}`);
  assert.equal(result.inputs.get('order id'), 'a1');
  assert.deepEqual(result.problems, [{
    line: 1, text: 'order-id: wrong', reason: 'write the label exactly as `order id:`',
  }]);
});

test('an exact empty label is diagnosed and is absent from accepted inputs', () => {
  for (const text of ['order id:', 'order id: \t']) {
    const result = parseDispatcherCall('codex-scout', `${text}\ntask file: C:/scratch/task.md`);
    lineProblem(result, 1, text, 'label `order id` has an empty value');
    assert.equal(result.inputs.has('order id'), false);
    assert.deepEqual(result.problems[1], {
      line: null, text: '', label: 'order id', reason: 'missing required label `order id`',
    });
  }
});

test('missing unconditional labels are reported in registry order with no source line', () => {
  for (const agent of agents) {
    const result = parseDispatcherCall(agent, ' \n\t');
    assert.equal(result.inputs.size, 0);
    assert.deepEqual(result.problems, requiredInputsFor(agent).filter((entry) => !entry.conditional)
      .map((entry) => ({
        line: null, text: '', label: entry.label, reason: `missing required label \`${entry.label}\``,
      })));
  }
});

test('placeholders are diagnosed on required and optional labels while advisor scope stays valid', () => {
  for (const value of ['TODO', '<order id>', 'none']) {
    const result = parseDispatcherCall('codex-scout', minimalCall('codex-scout', { 'order id': value }));
    assert.deepEqual(result.problems, [{
      line: 1, text: `order id: ${value}`, reason: 'label `order id` is still a placeholder',
    }]);
  }
  const result = parseDispatcherCall('codex-scout', `${minimalCall('codex-scout')}\nslug: TBD`);
  assert.equal(result.problems[0].reason, 'label `slug` is still a placeholder');
  assert.deepEqual(parseDispatcherCall('codex-advisor', minimalCall('codex-advisor')).problems, []);
});

test('task file paths must be absolute across Windows and POSIX', () => {
  for (const value of ['task.md', './task.md', '../task.md']) {
    const result = parseDispatcherCall('codex-scout', minimalCall('codex-scout', { 'task file': value }));
    assert.deepEqual(result.problems, [{
      line: 2, text: `task file: ${value}`, reason: 'label `task file` must be an absolute path',
    }]);
  }
  for (const value of ['C:/scratch/task.md', 'C:\\scratch\\task.md', '/tmp/task.md']) {
    assert.deepEqual(parseDispatcherCall('codex-scout', minimalCall('codex-scout', {
      'task file': value,
    })).problems, []);
  }
});

test('shell sequences, double quotes and embedded CR are refused for every non-grant label', () => {
  for (const agent of agents) {
    for (const entry of callInputsFor(agent)) {
      if (entry.label === 'continue' || entry.label === 'retry') continue;
      for (const sequence of [...SHELL_UNSAFE_SEQUENCES, '"', '\r']) {
        const value = `C:/safe${sequence}tail`;
        const base = minimalCall(agent, { [entry.label]: value });
        const prompt = entry.optional ? `${base}\n${entry.label}: ${value}` : base;
        const result = parseDispatcherCall(agent, prompt);
        assert.equal(result.problems.length, 1, `${agent}: ${entry.label} ${JSON.stringify(sequence)}`);
        assert.equal(result.inputs.get(entry.label), value);
        assert.equal(result.problems[0].reason,
          `label \`${entry.label}\` contains ${JSON.stringify(sequence)}; put free text in the task file`);
      }
    }
  }
});

test('unsafe diagnostics name the first sequence in reading order', () => {
  const result = parseDispatcherCall('codex-build', minimalCall('codex-build', { scope: 'src/"early;late' }));
  assert.equal(result.problems[0].reason, 'label `scope` contains "\\\""; put free text in the task file');
});

test('LF starts another line and cannot smuggle free text into an accepted value', () => {
  const result = parseDispatcherCall('codex-build', minimalCall('codex-build', { scope: 'src/**\nsmuggled text' }));
  assert.equal(result.inputs.get('scope'), 'src/**');
  lineProblem(result, 3, 'smuggled text', 'not a `label: value` line; free text belongs in the task file');
});

test('continue and retry values are left to the runner including placeholders and unsafe prose', () => {
  for (const agent of agents) {
    for (const label of ['continue', 'retry']) {
      for (const value of ['failed-run — retry; same pass', 'TODO', 'not a grant', 'run "quoted" $(reason)']) {
        const result = parseDispatcherCall(agent, `${minimalCall(agent)}\n${label}: ${value}`);
        assert.deepEqual(result.problems, []);
        assert.equal(result.inputs.get(label), value);
      }
      const result = parseDispatcherCall(agent, `${minimalCall(agent)}\n${label}:`);
      assert.equal(result.problems[0].reason, `label \`${label}\` has an empty value`);
    }
    const result = parseDispatcherCall(agent, `${minimalCall(agent)}\ncontinue: TODO\nretry: TODO`);
    assert.deepEqual(result.problems, []);
  }
});

test('refusal rendering includes exact problems, registry labels, statuses and task-file guidance', () => {
  for (const agent of agents) {
    const problems = [
      { line: 3, text: 'prose', reason: 'free text' },
      { line: null, text: '', reason: 'missing required label `order id`' },
    ];
    const lines = renderCallRefusal(agent, problems).split('\n');
    assert.equal(lines[0], 'Order gate denied the Agent call: the call text must be only `label: value` lines.');
    assert.equal(lines[1], '- line 3: `prose` — free text');
    assert.equal(lines[2], '- missing required label `order id`');
    const labels = callInputsFor(agent).map((entry) => {
      const status = entry.optional ? 'optional' : entry.conditional || 'required';
      return `\`${entry.label}\` (${status})`;
    });
    assert.equal(lines[3], `Labels for ${agent}: ${labels.join(', ')}`);
    assert.equal(lines[4], 'Free text belongs in the task file.');
  }
});
