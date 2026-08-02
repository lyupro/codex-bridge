/**
 * Reads the command line of a run and refuses it before anything is spent.
 *
 * Every check here happens before the run folder exists and before a single token of someone
 * else's quota is touched, and every refusal is an exit code rather than a message: a
 * dispatcher branches on it.
 */
import path from 'node:path';
import { AGENTS } from '../write-meta.mjs';

export function die(message) {
  console.error(`run-codex: ${message}`);
  process.exit(2);
}

// Flags that carry no value. A value is accepted only in its explicit yes/no spellings;
// anything else stops the run. The permissive reading this replaces — "not 0/false/no means
// yes" — turned the prompt's own placeholder text (`--continue "<only if the orchestrator provided
// continue>"`) into a silent opt-in, and a real run started on someone else's quota. A flag
// whose whole point is that a human decided it must never be switched on by a leftover
// template.
const BOOLEAN_FLAGS = new Set(['continue']);
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
    if (value === undefined) die(`missing value for ${key}`);
    opts[name] = value;
    i += 1;
  }
  if (!opts.agent) die('--agent is required');
  if (!AGENTS[opts.agent]) die(`unknown --agent ${opts.agent}`);
  // Effort levels are the provider's vocabulary and it changes: `minimal` was accepted
  // until the default model dropped it, `max` appeared. So the value is passed through
  // as given; an unsupported one comes back as a 400 in the log and becomes a FAIL with
  // the exact list Codex accepts. A whitelist here would only go stale.
  opts.effort = opts.effort || 'medium';
  if (/\s/.test(opts.effort)) die('--effort must be a single word');
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
    die(
      '--scope is required for codex-build: comma-separated globs relative to the repo root, ' +
        'e.g. --scope "packages/event-calendar/**,apps/orchestrator/src/maestro/calendar-refresh.ts". ' +
        'Anything outside the list is off limits and fails the run.',
    );
  }
  return opts;
}
