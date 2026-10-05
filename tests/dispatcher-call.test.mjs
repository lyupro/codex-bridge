import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { replacePlaceholders } from '../cli/manifest.mjs';
import {
  TASK_FILE_INPUT, callInputsFor, parseDispatcherCall, renderCallRefusal,
  renderRequiredInputSummary,
} from '../src/home/lib/dispatcher-call.mjs';
import {
  ALL_ORDER_LABELS, CONTINUATION_ORDER_INPUT, ORDER_AGENTS, RETRY_ORDER_INPUT,
  orderLabelsFor, renderOrderHeaderHelp,
} from '../src/home/lib/order-schema.mjs';
import { SHELL_UNSAFE_SEQUENCES } from '../src/home/lib/shell-unsafe.mjs';
import { canonicalRunCommand } from '../src/home/lib/dispatcher-command.mjs';
import { renderDispatcherProtocol } from '../src/home/lib/dispatcher-protocol.mjs';
import { AGENTS } from '../src/home/lib/write-meta.mjs';
import { renderNoSelfExecution } from '../src/home/lib/no-self-execution.mjs';
import { renderStopSummary } from '../src/home/lib/stop-contract.mjs';

const taskFile = 'C:/scratch/task.md';
const validCall = `task file: ${taskFile}`;
const agentDirectory = path.join('src', 'agents');
const freeTextReason = 'not a `label: value` line; free text belongs in the task file';

function movedReason(label) {
  return `label \`${label}\` moved to the task-file header; the call is only \`task file: <absolute path>\``;
}

function orderedHeaderEntries(agentType) {
  const entries = orderLabelsFor(agentType);
  return [
    ...entries.filter(({ required }) => required),
    ...entries.filter(({ conditional }) => conditional),
    ...entries.filter(({ optional }) => optional),
  ];
}

// Plan_63 D9: the call registry has no order metadata or flag channel.
test('every runner agent has exactly the task file call input without flag or source metadata', () => {
  assert.deepEqual(Object.keys(AGENTS).sort(), [...ORDER_AGENTS].sort());
  assert.equal(Object.isFrozen(TASK_FILE_INPUT), true);
  assert.deepEqual(Object.keys(TASK_FILE_INPUT).sort(), ['example', 'explanation', 'label']);
  assert.ok(TASK_FILE_INPUT.explanation.includes('written by the orchestrator with its file tool'));
  assert.ok(TASK_FILE_INPUT.explanation.includes('never creates, reads or rewrites'));
  assert.equal(TASK_FILE_INPUT.label, 'task file');
  for (const agent of ORDER_AGENTS) {
    assert.deepEqual(callInputsFor(agent), [TASK_FILE_INPUT]);
    assert.equal(callInputsFor(agent)[0], TASK_FILE_INPUT);
    assert.deepEqual(parseDispatcherCall(agent, validCall), {
      inputs: new Map([['task file', taskFile]]), problems: [],
    });
  }
  for (const unknown of ['codex-unknown', 'toString', 'constructor', '__proto__', undefined, null]) {
    assert.deepEqual(callInputsFor(unknown), []);
  }
});

test('blank lines, CRLF, tabs and outer whitespace are accepted', () => {
  for (const agent of ORDER_AGENTS) {
    assert.deepEqual(parseDispatcherCall(agent, `\r\n \t\r\n \ttask file:\t${taskFile} \t\r\n\r\n`), {
      inputs: new Map([['task file', taskFile]]), problems: [],
    });
  }
});

test('every former label in several spellings moves to the header for every agent', () => {
  for (const agent of ORDER_AGENTS) {
    for (const label of ALL_ORDER_LABELS) {
      for (const text of [
        `${label}: value`, `${label.replaceAll(' ', '-')}: value`,
        `${label.replaceAll(' ', '_')}: value`, `- **${label}:** value`,
        `* \`${label}\`: value`, `__${label}__: value`, `${label.toUpperCase()}: value`,
        `${label.replaceAll(' ', '  ')} : value`, `${label}:`, `${label}:value`,
      ]) {
        assert.deepEqual(parseDispatcherCall(agent, `${validCall}\n${text}`), {
          inputs: new Map([['task file', taskFile]]),
          problems: [{ line: 2, text, reason: movedReason(label) }],
        }, `${agent}: ${text}`);
      }
    }
  }
});

// OW-054: a placeholder continuation used to enable --continue and bypass the order-owner check.
test('continue none and retry TODO are refused before value or grant interpretation', () => {
  for (const agent of ORDER_AGENTS) {
    for (const [label, value] of [
      ['continue', 'none'], ['retry', 'TODO'],
      ['continue', 'run "quoted" $(reason)'], ['retry', 'failed-run — retry; same pass'],
    ]) {
      const text = `${label}: ${value}`;
      assert.deepEqual(parseDispatcherCall(agent, `${text}\n${validCall}`).problems, [
        { line: 1, text, reason: movedReason(label) },
      ]);
    }
    assert.equal(parseDispatcherCall(agent, `${validCall}\ncontinue: none\nretry: TODO`).problems.length, 2);
  }
});

test('noncanonical task file labels keep the exact-spelling diagnosis', () => {
  for (const text of [
    `task-file: ${taskFile}`, `task_file: ${taskFile}`, `TASK FILE: ${taskFile}`,
    `- **task file:** ${taskFile}`, `* \`task file\`: ${taskFile}`,
    `__task_file__: ${taskFile}`, `task  file: ${taskFile}`, `task\tfile: ${taskFile}`,
    `task file : ${taskFile}`, `task file:${taskFile}`, `task file:\u00a0${taskFile}`,
  ]) {
    const result = parseDispatcherCall('codex-scout', text);
    assert.equal(result.inputs.size, 0);
    assert.deepEqual(result.problems, [
      { line: 1, text, reason: 'write the label exactly as `task file:`' },
      { line: null, text: '', label: 'task file', reason: 'missing required label `task file`' },
    ]);
  }
});

test('prose, flags, unknown labels and alternate separators retain the free-text refusal', () => {
  for (const text of [
    'Repository root: C:/x', '--task-file C:/x', '--order-id a1',
    'Please implement the task', 'task file = C:/x', 'order id — a1', 'order id - a1', 'unknown: a1',
  ]) {
    assert.deepEqual(parseDispatcherCall('codex-scout', `${validCall}\n${text}`).problems, [
      { line: 2, text, reason: freeTextReason },
    ]);
  }
});

test('duplicates retain the first task path and diagnose both source line numbers', () => {
  for (const value of [taskFile, 'C:/scratch/second.md']) {
    const text = `task file: ${value}`;
    assert.deepEqual(parseDispatcherCall('codex-scout', `\n${validCall}\n${text}`), {
      inputs: new Map([['task file', taskFile]]),
      problems: [{ line: 3, text, reason: 'label `task file` is given twice (line 2 and line 3)' }],
    });
  }
});

test('invalid earlier spelling does not occupy the canonical label', () => {
  const text = 'task-file: C:/wrong.md';
  assert.deepEqual(parseDispatcherCall('codex-scout', `${text}\n${validCall}`), {
    inputs: new Map([['task file', taskFile]]),
    problems: [{ line: 1, text, reason: 'write the label exactly as `task file:`' }],
  });
});

test('empty task file is diagnosed and remains missing', () => {
  for (const text of ['task file:', 'task file: \t']) {
    assert.deepEqual(parseDispatcherCall('codex-scout', text), {
      inputs: new Map(),
      problems: [
        { line: 1, text, reason: 'label `task file` has an empty value' },
        { line: null, text: '', label: 'task file', reason: 'missing required label `task file`' },
      ],
    });
  }
});

test('a blank call requires only task file for every agent', () => {
  for (const agent of ORDER_AGENTS) {
    assert.deepEqual(parseDispatcherCall(agent, ' \n\t'), {
      inputs: new Map(),
      problems: [{ line: null, text: '', label: 'task file', reason: 'missing required label `task file`' }],
    });
  }
});

test('task-file placeholders are refused even when the label is present', () => {
  for (const value of ['TODO', 'TBD', 'none', 'LABEL', 'xxx', '<absolute path>', '<task file>']) {
    const result = parseDispatcherCall('codex-scout', `task file: ${value}`);
    assert.ok(result.problems.some(({ reason }) => reason === 'label `task file` is still a placeholder'), value);
  }
});

test('task file accepts Windows, UNC and POSIX absolute paths and rejects relative paths', () => {
  for (const value of ['task.md', './task.md', '../task.md', 'C:task.md']) {
    const text = `task file: ${value}`;
    assert.deepEqual(parseDispatcherCall('codex-scout', text).problems, [
      { line: 1, text, reason: 'label `task file` must be an absolute path' },
    ]);
  }
  for (const value of [taskFile, 'C:\\scratch\\task.md', '//host/share/task.md', '/tmp/task.md']) {
    assert.deepEqual(parseDispatcherCall('codex-scout', `task file: ${value}`).problems, [], value);
  }
});

test('a task path the shell would rewrite inside double quotes is refused, so gate and runner read one file', () => {
  const cases = [
    ['C:/scratch/$HOME/task.md', '$'],
    ['C:/scratch/$env:TEMP/task.md', '$'],
    ['\\\\host\\share\\task.md', '\\\\'],
    ['C:\\scratch\\\\task.md', '\\\\'],
    ['C:\\scratch\\', '\\'],
  ];
  for (const agent of ORDER_AGENTS) {
    for (const [value, sequence] of cases) {
      const text = `task file: ${value}`;
      assert.deepEqual(parseDispatcherCall(agent, text).problems, [{
        line: 1,
        text,
        reason: `label \`task file\` contains ${JSON.stringify(sequence)}, which the shell rewrites inside double quotes; `
          + 'write the path with forward slashes and without `$`',
      }], value);
    }
  }
  const refused = canonicalRunCommand('codex-scout', 'task file: C:/scratch/$HOME/task.md');
  assert.equal(refused.command, undefined);
  assert.match(refused.refusal, /shell rewrites inside double quotes/);
});

test('shell sequences, double quotes and embedded CR are refused in task paths', () => {
  for (const agent of ORDER_AGENTS) {
    for (const sequence of [...SHELL_UNSAFE_SEQUENCES, '"', '\r']) {
      const text = `task file: C:/safe${sequence}tail`;
      assert.deepEqual(parseDispatcherCall(agent, text).problems, [
        { line: 1, text, reason: `label \`task file\` contains ${JSON.stringify(sequence)}; put free text in the task file` },
      ]);
    }
  }
});

test('unsafe diagnostics name the first sequence in reading order', () => {
  const result = parseDispatcherCall('codex-scout', 'task file: C:/safe"tail;$(bad)');
  assert.equal(result.problems[0].reason, 'label `task file` contains "\\\""; put free text in the task file');
});

test('LF cannot smuggle another line into an accepted task path', () => {
  assert.deepEqual(parseDispatcherCall('codex-scout', `${validCall}\nsmuggled text`), {
    inputs: new Map([['task file', taskFile]]),
    problems: [{ line: 2, text: 'smuggled text', reason: freeTextReason }],
  });
});

test('unknown agents yield exactly one problem regardless of call text', () => {
  for (const agent of ['codex-unknown', 'constructor', '__proto__', undefined, null]) {
    for (const prompt of ['', `${validCall}\norder id: a1\nprose`]) {
      assert.deepEqual(parseDispatcherCall(agent, prompt), {
        inputs: new Map(),
        problems: [{ line: null, text: '', reason: `unknown dispatcher agent ${JSON.stringify(agent)}` }],
      });
    }
  }
});

test('refusal lists refused lines then the call rule and the agent header template', () => {
  for (const agent of ORDER_AGENTS) {
    const problems = [
      { line: 3, text: 'continue: none', reason: movedReason('continue') },
      { line: null, text: '', reason: 'synthetic missing value' },
    ];
    assert.equal(renderCallRefusal(agent, problems), [
      'Order gate denied the Agent call: the call text must be only `label: value` lines.',
      `- line 3: \`continue: none\` — ${movedReason('continue')}`,
      '- synthetic missing value',
      'The call is only `task file: <absolute path>`.',
      'The order goes in the header at the top of that file:',
      renderOrderHeaderHelp(agent),
      'Free text belongs in the task file.',
    ].join('\n'));
    const missing = renderCallRefusal(agent, parseDispatcherCall(agent, '').problems);
    assert.ok(missing.includes(`- missing required label \`task file\` — ${TASK_FILE_INPUT.explanation}`));
    assert.ok(missing.includes(`Example: \`task file: ${TASK_FILE_INPUT.example}\`.`));
  }
});

test('summary names only agent-owned header labels in required, conditional, optional order', () => {
  for (const agent of ORDER_AGENTS) {
    const summary = renderRequiredInputSummary(agent);
    assert.ok(summary.startsWith('The call is only `task file` (an absolute path).'));
    let previous = summary.indexOf('`task file`');
    for (const entry of orderedHeaderEntries(agent)) {
      const index = summary.indexOf(`\`${entry.label}\``);
      assert.ok(index > previous, `${agent}: ${entry.label}`);
      previous = index;
    }
    for (const grant of [CONTINUATION_ORDER_INPUT, RETRY_ORDER_INPUT]) {
      assert.ok(summary.includes(`\`${grant.label}\` (${grant.conditional})`));
    }
    for (const label of ALL_ORDER_LABELS) {
      if (!orderLabelsFor(agent).some((entry) => entry.label === label)) {
        assert.equal(summary.includes(`\`${label}\``), false, `${agent}: ${label}`);
      }
    }
    assert.ok(summary.endsWith('Free text belongs in the task file.'));
    assert.doesNotMatch(summary, /--continue|--order-id|--scope|--task-file/);
  }
  assert.equal(renderRequiredInputSummary('unknown-agent'), '');
  assert.match(renderRequiredInputSummary('codex-advisor'), /`phase`/);
});

test('every dispatcher markdown carries the shared no-self-execution placeholder first', async () => {
  const files = (await fs.readdir(agentDirectory)).filter((file) => file.endsWith('.md')).sort();
  assert.deepEqual(files, Object.keys(AGENTS).map((agent) => `${agent}.md`).sort());
  for (const file of files) {
    const source = await fs.readFile(path.join(agentDirectory, file), 'utf8');
    const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trimStart();
    assert.match(body, /^\{\{CODEX_NO_SELF_EXECUTION\}\}/, file);
  }
});

test('expanded dispatcher prompts retain no-self-execution and stop guidance with the new contract', async () => {
  for (const agent of ORDER_AGENTS) {
    const source = await fs.readFile(path.join(agentDirectory, `${agent}.md`), 'utf8');
    const rendered = replacePlaceholders(source, path.resolve('installed', 'agents'));
    const frontmatter = rendered.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
    assert.ok(frontmatter, agent);
    assert.ok(frontmatter.includes(renderRequiredInputSummary(agent)), agent);
    assert.ok(frontmatter.includes(renderStopSummary()), agent);
    assert.ok(rendered.includes(renderDispatcherProtocol(agent)), agent);
    if (agent === 'codex-advisor') {
      assert.match(rendered, /`phase: scope` first, then `phase: advise`/);
      assert.match(rendered, /same order's successful advisor scope run/);
      assert.match(rendered, /`advise` header includes a `continue:`\s+grant naming the scope run/);
    }
    assert.ok(rendered.includes(renderNoSelfExecution()), agent);
    assert.doesNotMatch(rendered, /\{\{/);
    assert.deepEqual(parseDispatcherCall(agent, `task file: ${TASK_FILE_INPUT.example}`).problems, []);
  }
});
