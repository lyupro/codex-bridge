/**
 * What a run asks Codex to do: the model, the reasoning depth and the flag set per agent.
 *
 * Split out of codex-cmd.mjs when that file outgrew the size limit; the seam is deliberate, not
 * arithmetic — starting a process and deciding what it is asked to do are different jobs, and
 * only this half needs to know the run's configuration.
 *
 * The flag sets are the ones the three agent files carried before, verbatim. Sandboxes especially
 * must not drift: codex-scout and codex-review are read-only through an explicit --sandbox
 * read-only, and codex-build needs workspace-write and must NOT get --ignore-user-config. What
 * --ignore-user-config buys the two read-only agents is isolation from the operator's config,
 * never the sandbox itself — reading it as the read-only guarantee is how the 2026-08-23 breakage
 * stayed misdiagnosed as "read-only is broken" (see sandbox-flags.mjs for what actually stops a
 * run from starting a process on Windows).
 */
import path from 'node:path';
import { CLEAN_ENV, RUN_ENV } from './run-env.mjs';
import { platformSandboxArgs } from './sandbox-flags.mjs';

/**
 * Which model runs a mode, and how deep it reasons.
 *
 * Three sources, in this order: what the dispatcher asked for this one task, the mode's
 * configured profile, and finally a depth to fall back on. The order is the whole point —
 * pinning a model without its depth leaves every run at the fallback, which is how a mode
 * configured for maximum reasoning would quietly keep working at the shallowest setting.
 */
const FALLBACK_EFFORT = 'medium';

/**
 * A run is one worker, not a team it recruits for itself.
 *
 * Codex can spawn subagents when a prompt asks it to, and their edits land in the same
 * worktree — so they arrive in the snapshot as the run's own work, outside the scope check
 * that grades it, on quota nobody budgeted. The prompts say not to; this is why they cannot.
 */
const NO_SUBAGENTS = ['-c', 'agents.enabled=false'];

/**
 * Which configured mode an agent is. One table, because the launcher needs the same answer to
 * pick a run's time budget: a second copy of this mapping is a second place to forget a mode.
 */
export const runMode = (agent) =>
  ({
    'codex-scout': 'scout',
    'codex-build': 'build',
    'codex-review': 'review',
  })[agent];

/**
 * Which model and depth this run gets, and — as part of the same answer — where each came from.
 *
 * The provenance is not decoration. A configured profile failed to reach any run for three
 * releases (2026-08-26) and nothing said so: the reply named no model, meta.json recorded none,
 * and a depth silently served by the fallback is indistinguishable from one the operator chose.
 * `model_source` is `config` or `codex default`; `effort_source` is `request`, `config` or
 * `fallback`, in the order the values are consulted above.
 */
export function runProfile(opts) {
  const mode = runMode(opts.agent);
  // opts.models is how tests state a configuration; a real run reads the one loaded for it.
  const configured = (opts.models || RUN_ENV?.models || {})[mode] || {};
  return {
    model: configured.model || '',
    model_source: configured.model ? 'config' : 'codex default',
    effort: opts.effort || configured.effort || FALLBACK_EFFORT,
    effort_source: opts.effort ? 'request' : configured.effort ? 'config' : 'fallback',
  };
}

export function codexArgs(opts, runDir, isGitRepo) {
  const schema = path.join(runDir, 'schema.json');
  const profile = runProfile(opts);
  const effort = `model_reasoning_effort=${profile.effort}`;
  const modelArgs = profile.model ? ['-m', profile.model] : [];
  if (opts.agent === 'codex-scout') {
    return [
      'exec',
      '--json',
      ...CLEAN_ENV,
      '--ignore-user-config',
      '-c',
      effort,
      ...NO_SUBAGENTS,
      ...platformSandboxArgs(),
      ...modelArgs,
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '-C',
      opts.repo,
      '--output-schema',
      schema,
      '-o',
      path.join(runDir, 'result.json'),
      '-',
    ];
  }
  if (opts.agent === 'codex-build') {
    // --ignore-user-config is deliberately absent: with it Codex forces read-only and
    // every edit is rejected ("writing is blocked by read-only sandbox").
    return [
      'exec',
      '--json',
      ...CLEAN_ENV,
      '-c',
      effort,
      ...NO_SUBAGENTS,
      ...platformSandboxArgs(),
      ...modelArgs,
      '--sandbox',
      'workspace-write',
      '-C',
      opts.repo,
      ...(isGitRepo ? [] : ['--skip-git-repo-check']),
      '--output-schema',
      schema,
      '-o',
      path.join(runDir, 'result.json'),
      '-',
    ];
  }
  // codex-review deliberately does NOT use the `review` subcommand. Two of its traits
  // break the contract this design rests on: it rejects a scope flag together with a
  // prompt ("the argument '--uncommitted' cannot be used with '[PROMPT]'"), so task.md
  // was silently discarded and the review rules never arrived; and it ignores
  // --output-schema, writing prose into -o, so the old JSON parsing of review.json could
  // only ever fail — which is what pushed a dispatcher into reviewing the diff itself.
  //
  // Plain `codex exec` honours the schema (proven by codex-scout), so the review comes
  // back as machine-checkable JSON. Scope lives in the prompt as a file list plus the
  // exact diff command computed by reviewScope(). Read-only through
  // --ignore-user-config, same as scout: review never needs write access.
  return [
    'exec',
    '--json',
    ...CLEAN_ENV,
    '--ignore-user-config',
    '-c',
    effort,
    ...NO_SUBAGENTS,
    ...platformSandboxArgs(),
    ...modelArgs,
    '--sandbox',
    'read-only',
    '-C',
    opts.repo,
    '--output-schema',
    schema,
    '-o',
    path.join(runDir, 'review.json'),
    '-',
  ];
}
