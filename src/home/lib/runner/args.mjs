/**
 * Reads the command line of a run and refuses it before anything is spent.
 *
 * Every check here happens before the run folder exists and before a single token of someone
 * else's quota is touched, and every refusal is an exit code rather than a message: a
 * dispatcher branches on it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { AGENTS } from '../write-meta.mjs';
import { ALLOWED_EFFORTS } from '../run-config.mjs';
import { isAbsoluteTaskFilePath, requiredInputsFor } from '../required-inputs.mjs';
import { firstShellUnsafeSequence } from '../shell-unsafe.mjs';
import { parseTaskDocument } from './task-file.mjs';

export class RunnerUsageError extends Error {
  constructor(message) {
    super(message);
    this.exitCode = 2;
  }
}

export function die(message) {
  console.error(`run-codex: ${message}`);
  throw new RunnerUsageError(message);
}

export function readTaskDocument(opts) {
  const stdinText = process.stdin.isTTY ? '' : fs.readFileSync(0, 'utf8');
  if (opts['task-file'] !== undefined) {
    if (stdinText.trim()) {
      die('task text was supplied through both stdin and --task-file; choose exactly one channel');
    }
    const taskFile = opts['task-file'];
    // The 2026-08-15 incident resolved a relative order against the repository cwd and ran an
    // unrelated task.md. Refuse the supplied value instead of silently selecting another file.
    if (!isAbsoluteTaskFilePath(taskFile)) {
      die(`--task-file must be an absolute path; got ${JSON.stringify(taskFile)}`);
    }
    let fileText;
    try {
      fileText = fs.readFileSync(taskFile, 'utf8');
    } catch (err) {
      die(`task file from --task-file could not be read: ${err.message}`);
    }
    if (!fileText.trim()) die(`task file from --task-file is empty: ${taskFile}`);
    let document;
    try {
      document = parseTaskDocument(fileText);
    } catch (err) {
      die(`${taskFile}: ${err.message}`);
    }
    if (document.questions.length && opts.questions?.length) {
      die('questions were supplied through both --question and the task file; choose exactly one channel');
    }
    if (document.verify !== undefined && opts.verify !== undefined) {
      die('verification command was supplied through both --verify and the task file; choose exactly one channel');
    }
    return document;
  }
  if (!stdinText.trim()) die('task text on stdin is empty');
  try {
    return parseTaskDocument(stdinText);
  } catch (err) {
    die(err.message);
  }
}

function requiredInput(agentType, label) {
  return requiredInputsFor(agentType).find((entry) => entry.label === label);
}

// Flags that carry no value. A value is accepted only in its explicit yes/no spellings;
// anything else stops the run. The permissive reading this replaces — "not 0/false/no means
// yes" — turned the prompt's own placeholder text (`--continue "<only if the orchestrator provided
// continue>"`) into a silent opt-in, and a real run started on someone else's quota. A flag
// whose whole point is that a human decided it must never be switched on by a leftover
// template.
const BOOLEAN_FLAGS = new Set(['continue', 'no-wait']);
const REPEATABLE_FLAGS = new Set(['question']);
// Plan_42 keeps free text in the task file because these command-line values otherwise disable
// the host's standing permission before the runner can spend quota.
const SHELL_CHECKED_FLAGS = Object.freeze([
  'order-id',
  'slug',
  'scope',
  'scope-new',
  'repo',
  'agent',
  'effort',
  'mode',
  'task-file',
]);
const BOOLEAN_YES = /^(1|true|yes)$/i;
const BOOLEAN_NO = /^(0|false|no)$/i;

export function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) die(`unexpected argument: ${key}`);
    const name = key.slice(2);
    const value = argv[i + 1];
    if (BOOLEAN_FLAGS.has(name)) {
      if (value !== undefined && !value.startsWith('--')) {
        if (!BOOLEAN_YES.test(value) && !BOOLEAN_NO.test(value)) {
          die(
            `--${name} takes no value, or one of 1/true/yes/0/false/no; got ${JSON.stringify(value)}. ` +
              'A placeholder left in from the prompt template is not consent.',
          );
        }
        opts[name] = BOOLEAN_YES.test(value);
        i += 1;
      } else {
        opts[name] = true;
      }
      continue;
    }
    // A flag name where a value belongs means the value was left out: `--question --continue`
    // otherwise records `--continue` as the question and passes every later check.
    if (value === undefined || value.startsWith('--')) die(`missing value for ${key}`);
    if (REPEATABLE_FLAGS.has(name)) {
      if (!opts.questions) opts.questions = [];
      opts.questions.push(value);
      i += 1;
      continue;
    }
    opts[name] = value;
    i += 1;
  }
  for (const name of SHELL_CHECKED_FLAGS) {
    if (opts[name] === undefined) continue;
    const sequence = firstShellUnsafeSequence(opts[name]);
    if (sequence !== null) {
      die(
        `--${name} contains forbidden shell sequence ${JSON.stringify(sequence)}; ` +
          'put free text in the task file and pass only a short command-line value.',
      );
    }
  }
  if (!opts.agent) die('--agent is required');
  if (!AGENTS[opts.agent]) die(`unknown --agent ${opts.agent}`);
  opts.orderId = String(opts['order-id'] ?? '').trim();
  opts.noWait = Boolean(opts['no-wait']);
  if (opts.noWait && opts.continue) {
    die('--no-wait cannot be combined with --continue: checking an existing run must never authorize a new one.');
  }
  if (!opts.orderId) {
    const orderInput = requiredInput(opts.agent, 'order id');
    die(
      `--order-id is required: ${orderInput.source} supplies the ${orderInput.label}; the runner will not invent one. ` +
        'A repeat of the same order should come back with --continue. If this appeared right after a package update, ' +
        'the installed dispatcher prompts are stale and need npm run dev:install (local dev) or codex-bridge update. ' +
        `Example: --order-id "${orderInput.example}". Action: get the value from ${orderInput.source}, pass it as --order-id, and retry.`,
    );
  }
  if (opts.agent === 'codex-scout') {
    // The requirement itself moved to the launcher, which is the first point that has seen both
    // sources: questions now arrive either as flags or as a section of the task file, and this
    // check runs before either file or stdin has been read. Only the shape of a supplied flag is
    // still judged here.
    if (opts.questions?.some((question) => !String(question).trim())) {
      die('--question must not be empty for codex-scout; no quota was spent');
    }
  }
  const allowedEfforts = ALLOWED_EFFORTS.join(', ');
  // Left unset when not given, rather than defaulted here: the mode's configured profile is
  // what fills the gap, and a default applied this early would always win over it.
  if (opts.effort !== undefined && /\s/.test(opts.effort)) {
    die(`--effort must be a single word; allowed values: ${allowedEfforts}`);
  }
  if (opts.effort !== undefined && !ALLOWED_EFFORTS.includes(opts.effort)) {
    die(`--effort must be one of: ${allowedEfforts}; got ${JSON.stringify(opts.effort)}`);
  }
  opts.repo = path.resolve(opts.repo || process.cwd());
  const slugSource = opts.slug ? '--slug' : '--order-id';
  opts.slug = (opts.slug || opts.orderId).replace(/[^A-Za-z0-9._-]+/g, '-');
  // Plan_29 incident: the generic `build` slug made an honest order inherit a days-old chain;
  // reject a value with no alphanumeric anchor instead of creating an empty or dot-only folder.
  if (!/[A-Za-z0-9]/.test(opts.slug)) {
    die(
      `${slugSource} produces an unusable run folder name after sanitization: ` +
        `${JSON.stringify(opts.slug)} must contain a letter or digit.`,
    );
  }
  opts.mode = opts.mode || 'uncommitted';
  // A writing run without a declared scope is how `!Plans/*.md` got edited by a run that was
  // told in prose not to touch them: prose does not bind, a file list does. Required rather
  // than defaulted to "everything", and checked here — before the folder exists and before a
  // single token of someone else's quota is spent.
  const declaredScopePatterns = String(opts.scope || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  opts.scopeNewPatterns = String(opts['scope-new'] || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  // Plan_27 keeps ordinary patterns strict: only paths named explicitly as new may be absent.
  opts.scopePatterns = [...declaredScopePatterns, ...opts.scopeNewPatterns];
  // Only the writing agent creates files, so only its scope may name one that does not exist yet.
  // Accepting the flag elsewhere would hand scout and review a way to waive the check for nothing.
  if (opts.agent !== 'codex-build' && opts.scopeNewPatterns.length) {
    die(
      `--scope-new is only for codex-build: ${opts.agent} does not create files. ` +
        'Action: drop --scope-new and pass every path through --scope.',
    );
  }
  if (opts.agent === 'codex-build' && !declaredScopePatterns.length) {
    const scopeInput = requiredInput(opts.agent, 'scope');
    die(
      `--scope is required for codex-build: ${scopeInput.source} supplies the ${scopeInput.label}. ` +
        `${scopeInput.explanation} Example: --scope "${scopeInput.example}". ` +
        `Action: get the value from ${scopeInput.source}, pass it as --scope, and retry.`,
    );
  }
  return opts;
}
