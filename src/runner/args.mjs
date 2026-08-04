/**
 * Reads the command line of a run and refuses it before anything is spent.
 *
 * Every check here happens before the run folder exists and before a single token of someone
 * else's quota is touched, and every refusal is an exit code rather than a message: a
 * dispatcher branches on it.
 */
import path from 'node:path';
import { AGENTS } from '../write-meta.mjs';
import { ALLOWED_EFFORTS } from '../run-config.mjs';
import { requiredInputsFor } from '../required-inputs.mjs';

export function die(message) {
  console.error(`run-codex: ${message}`);
  process.exit(2);
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
const BOOLEAN_FLAGS = new Set(['continue']);
const REPEATABLE_FLAGS = new Set(['question']);
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
  if (!opts.agent) die('--agent is required');
  if (!AGENTS[opts.agent]) die(`unknown --agent ${opts.agent}`);
  opts.orderId = String(opts['order-id'] ?? '').trim();
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
    if (!opts.questions?.length) {
      die(
        '--question is required for codex-scout: repeat it once for every sub-question the orchestrator gave. ' +
          'The runner will not infer questions from the task text; no quota was spent.',
      );
    }
    if (opts.questions.some((question) => !String(question).trim())) {
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
  opts.slug = (opts.slug || opts.agent.replace(/^codex-/, '')).replace(/[^A-Za-z0-9._-]+/g, '-');
  opts.mode = opts.mode || 'uncommitted';
  // A writing run without a declared scope is how `!Plans/*.md` got edited by a run that was
  // told in prose not to touch them: prose does not bind, a file list does. Required rather
  // than defaulted to "everything", and checked here — before the folder exists and before a
  // single token of someone else's quota is spent.
  opts.scopePatterns = String(opts.scope || '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (opts.agent === 'codex-build' && !opts.scopePatterns.length) {
    const scopeInput = requiredInput(opts.agent, 'scope');
    die(
      `--scope is required for codex-build: ${scopeInput.source} supplies the ${scopeInput.label}. ` +
        `${scopeInput.explanation} Example: --scope "${scopeInput.example}". ` +
        `Action: get the value from ${scopeInput.source}, pass it as --scope, and retry.`,
    );
  }
  return opts;
}
