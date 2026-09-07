#!/usr/bin/env node
/**
 * Reads and edits the environment switches of a delegated Codex run:
 *   node run-config.mjs                # show current state
 *   node run-config.mjs hooks on       # let the operator's hooks run
 *   node run-config.mjs plugins off    # keep plugins out of the run
 *   node run-config.mjs reset          # back to defaults (both off)
 *
 * Why a switch at all: hooks and plugins from ~/.codex are the operator's interactive
 * setup, and a delegated run has no business inheriting it — a failing oh-my-codex `Stop`
 * hook once made Codex quarantine .omx/state/session.json instead of doing the job. But
 * "never" is the wrong contract too: some plugin may turn out to be exactly what a run
 * needs. So the default is off, and turning it back on is one command rather than an edit
 * to run-codex.mjs.
 *
 * The file is optional. Its absence is the default, not an error; a malformed one is an
 * error, because a typo must not silently change how runs behave.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND_CONFIG_PATH, BRAND_HOME } from './brand-home.mjs';
import { readJsonFileSync } from './json-file.mjs';
import { editRunConfig } from './config-edit.mjs';
import { DEFAULTS, ROLES, SWITCH_KEYS, LIST_KEYS, OBJECT_KEYS, validateRunConfig } from './config-validate.mjs';
export { DEFAULTS, DEFAULT_ENVIRONMENT_PATHS } from './config-validate.mjs';

export const CONFIG_PATH = BRAND_CONFIG_PATH;

/**
 * Every print of the state says which file was read AND why that one. The defect this replaced was
 * invisible precisely because the path was never shown beside its origin: two files named
 * config.json, and no way to tell from the output which of them the run had just used.
 */
const ORIGIN =
  BRAND_HOME.source === 'CODEX_BRIDGE_HOME' ? 'from CODEX_BRIDGE_HOME' : 'default location';

export function retentionNotice(config) {
  if (config?.retention?.enabled) {
    const days = config.retention.days;
    return {
      enabled: true,
      text: `Automatic cleanup is ON — run transport older than ${days} days is removed to reclaim disk space. Accounting and reports are never touched. Change or disable: retention in config.json.`,
    };
  }
  return {
    enabled: false,
    text: 'Automatic cleanup is OFF — run transport is retained until manually pruned.',
  };
}

export function readRunConfig(file = CONFIG_PATH) {
  let parsed;
  try {
    parsed = readJsonFileSync(file);
  } catch (err) {
    if (err.code) return { ...DEFAULTS };
    throw new Error(
      `${file} cannot be parsed as JSON (${err.cause?.message || err.message}). Fix or delete the file — without it, ` +
        'the default mode applies: hooks and plugins are disabled.',
    );
  }
  return validateRunConfig(file, parsed);
}

/** Flags for `codex exec`: a switch that is off becomes an explicit --disable. */
export const disableFlags = (config) =>
  SWITCH_KEYS.filter((key) => !config[key]).flatMap((key) => ['--disable', key]);

const state = (config) => [
  ...SWITCH_KEYS.map(
    (key) => `${key}: ${config[key] ? 'on — operator extensions enabled' : 'off — disabled for the run'}`,
  ),
  `environmentPaths: ${(config.environmentPaths || []).length} patterns — changes in them are ` +
    'treated as environment work, not run work',
  `models: ${ROLES.map((key) => {
    const profile = config.models?.[key];
    if (!profile?.model && !profile?.effort && !profile?.speed) return `${key}: default — chosen by Codex`;
    const model = profile.model || 'default model';
    return `${key}: ${model}${profile.effort ? ` at ${profile.effort} effort` : ''}`
      + (profile.speed ? ` on ${profile.speed} tier` : '');
  }).join('; ')}`,
  `budgets: ${ROLES.map((role) => `${role}: ${config.budgets?.[role] ?? DEFAULTS.budgets[role]} minutes`).join('; ')}`,
  `retention: ${config.retention?.enabled ? `on — transport older than ${config.retention.days} days` : 'off — automatic cleanup disabled'}`,
];

async function main(argv) {
  const [key, value] = argv;

  if (!key) {
    const config = readRunConfig();
    console.log([...state(config), `File: ${CONFIG_PATH} (${ORIGIN})`].join('\n'));
    return 0;
  }

  if (key === 'reset') {
    await editRunConfig({ reset: true });
    console.log([...state(DEFAULTS), `Reset to defaults · ${CONFIG_PATH} (${ORIGIN})`].join('\n'));
    return 0;
  }

  if (!SWITCH_KEYS.includes(key)) {
    const known = LIST_KEYS.includes(key)
      ? `“${key}” is a pattern list, not a switch: edit it directly in ${CONFIG_PATH}`
      : OBJECT_KEYS.includes(key)
        ? `“${key}” is not a switch: change it with “codex-bridge model set <role> <model> [effort]” `
          + `or “codex-bridge model unset <role>”, which check the pair against the live catalogue`
        : `unknown switch “${key}”. Allowed: ${SWITCH_KEYS.join(', ')}, reset`;
    console.error(`run-config: ${known}`);
    return 2;
  }
  if (value !== 'on' && value !== 'off') {
    console.error(`run-config: value must be on or off, received “${value ?? '(empty)'}”`);
    return 2;
  }

  const config = await editRunConfig({ key, value: value === 'on' });
  console.log([...state(config), `File: ${CONFIG_PATH} (${ORIGIN})`].join('\n'));
  return 0;
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (err) {
    console.error(`run-config: ${err.message}`);
    process.exit(2);
  }
}
