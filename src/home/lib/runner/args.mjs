/**
 * Reads the command line of a run and refuses it before anything is spent.
 *
 * Every check here happens before the run folder exists and before a single token of someone
 * else's quota is touched, and every refusal is an exit code rather than a message: a
 * dispatcher branches on it.
 */
import { EXIT } from './exit-codes.mjs';
import fs from 'node:fs';
import { AGENTS } from '../write-meta.mjs';
import { isAbsoluteTaskFilePath } from '../order-values.mjs';
import { firstShellUnsafeSequence } from '../shell-unsafe.mjs';
import { parseTaskDocument } from './task-file.mjs';
import { parseTaskHeader, taskHeaderRefusal } from '../task-header.mjs';
import { renderOrderHeaderHelp } from '../order-schema.mjs';
import { orderRuleMessage, orderRefusalAt } from '../order-rules.mjs';
import { orderDiagnosticMessage } from '../order-diagnostics.mjs';

export class RunnerUsageError extends Error {
  // 2 says the order itself is wrong and has to be rewritten. A refusal about the state of the
  // host or the worktree passes 1: the order was fine, nothing about it needs changing, and
  // Plan_58 moved two such refusals here from a code path that already answered 1.
  constructor(message, exitCode = EXIT.USAGE) {
    super(message);
    this.exitCode = exitCode;
  }
}

export function die(message, exitCode = EXIT.USAGE) {
  console.error(`run-codex: ${message}`);
  throw new RunnerUsageError(message, exitCode);
}

export function readTaskDocument(opts) {
  const refuse = (message) => die([message, renderOrderHeaderHelp(opts.agent)].filter(Boolean).join('\n'));
  const stdinText = process.stdin.isTTY ? '' : fs.readFileSync(0, 'utf8');
  if (opts['task-file'] !== undefined) {
    if (stdinText.trim()) {
      refuse(orderDiagnosticMessage('task-channel-conflict'));
    }
    const taskFile = opts['task-file'];
    // The 2026-08-15 incident resolved a relative order against the repository cwd and ran an
    // unrelated task.md. Refuse the supplied value instead of silently selecting another file.
    if (!isAbsoluteTaskFilePath(taskFile)) {
      refuse(orderRuleMessage('task-file-path', { value: taskFile }));
    }
    let fileText;
    try {
      fileText = fs.readFileSync(taskFile, 'utf8');
    } catch (err) {
      refuse(orderDiagnosticMessage('task-file-readable', { message: err.message }));
    }
    if (!fileText.trim()) refuse(orderRuleMessage('task-body-required', { channel: 'task-file', taskFile }));
    // Plan_75 D5, 2026-10-03 20:42: validate raw metadata before sections can hide a grant.
    const parsed = parseTaskHeader(fileText);
    const refusal = taskHeaderRefusal(parsed);
    if (refusal) refuse(orderRefusalAt(taskFile, refusal));
    if (!parsed.body.trim()) refuse(orderRuleMessage('task-body-required', { channel: 'task-file', taskFile }));
    let document;
    try {
      document = parseTaskDocument(parsed.body);
    } catch (err) {
      refuse(orderRefusalAt(taskFile, err.message));
    }
    return { ...document, header: parsed };
  }
  if (!stdinText.trim()) refuse(orderRuleMessage('task-body-required', { channel: 'stdin' }));
  const parsed = parseTaskHeader(stdinText);
  const refusal = taskHeaderRefusal(parsed);
  if (refusal) refuse(refusal);
  if (!parsed.body.trim()) refuse(orderRuleMessage('task-body-required', { channel: 'stdin' }));
  try {
    return { ...parseTaskDocument(parsed.body), header: parsed };
  } catch (err) {
    refuse(err.message);
  }
}

// Flags that carry no value. A value is accepted only in its explicit yes/no spellings;
// anything else stops the run. The permissive reading this replaces — "not 0/false/no means
// yes" — turned the prompt's own placeholder text (`--continue "<only if the orchestrator provided
// continue>"`) into a silent opt-in, and a real run started on someone else's quota. A flag
// whose whole point is that a human decided it must never be switched on by a leftover
// template.
const BOOLEAN_FLAGS = new Set(['no-wait']);
// Plan_42 keeps free text in the task file because these command-line values otherwise disable
// the host's standing permission before the runner can spend quota.
const SHELL_CHECKED_FLAGS = Object.freeze([
  'agent',
  'task-file',
]);
const BOOLEAN_YES = /^(1|true|yes)$/i;
const BOOLEAN_NO = /^(0|false|no)$/i;

export function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) die(orderDiagnosticMessage('unexpected-argument', { value: key }));
    const name = key.slice(2);
    if (!['agent', 'task-file', 'no-wait'].includes(name)) {
      const agent = opts.agent ?? argv[argv.indexOf('--agent') + 1];
      const help = Object.hasOwn(AGENTS, agent) ? renderOrderHeaderHelp(agent) : '';
      die(orderDiagnosticMessage('unknown-flag', { name, help }));
    }
    const value = argv[i + 1];
    if (BOOLEAN_FLAGS.has(name)) {
      if (value !== undefined && !value.startsWith('--')) {
        if (!BOOLEAN_YES.test(value) && !BOOLEAN_NO.test(value)) {
          die(orderDiagnosticMessage('boolean-flag-value', { name, value }));
        }
        opts[name] = BOOLEAN_YES.test(value);
        i += 1;
      } else {
        opts[name] = true;
      }
      continue;
    }
    // A flag name where a value belongs means the value was left out.
    if (value === undefined || value.startsWith('--')) die(orderDiagnosticMessage('missing-flag-value', { key }));
    opts[name] = value;
    i += 1;
  }
  for (const name of SHELL_CHECKED_FLAGS) {
    if (opts[name] === undefined) continue;
    const sequence = firstShellUnsafeSequence(opts[name]);
    if (sequence !== null) {
      die(orderDiagnosticMessage('flag-shell-safety', { name, sequence }));
    }
  }
  if (!opts.agent) die(orderDiagnosticMessage('agent-required'));
  if (!AGENTS[opts.agent]) die(orderDiagnosticMessage('agent-known', { agent: opts.agent }));
  opts.noWait = Boolean(opts['no-wait']);
  return opts;
}
