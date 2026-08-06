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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CONFIG_PATH = path.join(HERE, 'run-config.json');

const BUDGET_KEY = 'budgets';
const BUDGET_MODES = ['scout', 'build', 'review'];
const DEFAULT_BUDGETS = { scout: 15, build: 25, review: 20 };
const RETENTION_KEY = 'retention';
const RETENTION_FIELDS = ['enabled', 'days'];
const DEFAULT_RETENTION = { enabled: true, days: 30 };

/**
 * Files the surrounding tooling writes on its own, in any repository a run touches.
 *
 * A run is graded by comparing the worktree either side of it, which silently assumes the
 * run is the only writer. It is not: OMC rewrites .omc/ and Claude Code rewrites its own
 * caches while Codex works, and on 2026-08-02 an honest run was failed for
 * “out-of-scope changes: .omc/project-memory.json” — a file Codex never opened. These paths are
 * therefore attributed to the environment rather than to the run. They are not hidden: the
 * reply and meta.json list them separately, so a run that really did edit them is still visible.
 */
export const DEFAULT_ENVIRONMENT_PATHS = [
  '.omc/**',
  '.claude/settings.local.json',
  // Claude Code's own state, which only exists when the repository under a run is ~/.claude.
  'mcp-needs-auth-cache.json',
  'plugins/installed_plugins.json',
  'plugins/known_marketplaces.json',
];

/** Off means the flag is passed to Codex as `--disable <key>`. */
export const DEFAULTS = {
  hooks: false,
  plugins: false,
  models: {},
  budgets: DEFAULT_BUDGETS,
  retention: DEFAULT_RETENTION,
  environmentPaths: DEFAULT_ENVIRONMENT_PATHS,
  answerLanguage: 'English',
};

/** Booleans the operator flips from the command line; structured keys are edited in the file. */
const SWITCH_KEYS = ['hooks', 'plugins'];
const LIST_KEYS = ['environmentPaths'];
const OBJECT_KEYS = ['models'];
const MODEL_KEYS = ['scout', 'build', 'review'];
/**
 * A mode is configured as a pair, not as a model alone: reasoning depth is half of what a
 * model is worth. A cheap model at its default depth is a different worker from the same
 * model at "max", and pinning only the name would have silently kept every run at the
 * fallback depth the dispatcher happens to pass.
 */
const PROFILE_KEYS = ['model', 'effort'];
export const ALLOWED_EFFORTS = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
/**
 * The language a run answers in. Left to the model it followed the task, the surrounding docs or
 * its own default: an English order came back in Russian, and artifacts of one project ended up in
 * two languages. English is the default because the package is read by strangers.
 */
const STRING_KEYS = ['answerLanguage'];
const KEYS = [...SWITCH_KEYS, ...LIST_KEYS, ...OBJECT_KEYS, ...STRING_KEYS, BUDGET_KEY, RETENTION_KEY];

function readRetention(file, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      `${file}: key “${RETENTION_KEY}” must be an object with enabled and days, not ${JSON.stringify(value)}`,
    );
  }
  for (const key of Object.keys(value)) {
    if (!RETENTION_FIELDS.includes(key)) {
      throw new Error(
        `${file}: key “${RETENTION_KEY}” has unknown field “${key}”. ` +
          `Only ${RETENTION_FIELDS.join(', ')} are allowed`,
      );
    }
  }
  if (typeof value.enabled !== 'boolean') {
    throw new Error(
      `${file}: key “${RETENTION_KEY}.enabled” must be true or false, not ${JSON.stringify(value.enabled)}`,
    );
  }
  // Plan_17 step 4 does not read days when disabled, so stale values cannot revive deletion after
  // the step 3 incident where a copied default silently turned cleanup back on.
  if (!value.enabled) return { enabled: false };
  if (typeof value.days !== 'number' || !Number.isFinite(value.days) || value.days <= 0) {
    throw new Error(
      `${file}: key “${RETENTION_KEY}.days” must be a positive number of days, not ${JSON.stringify(value.days)}`,
    );
  }
  return { enabled: true, days: value.days };
}

export function retentionNotice(config) {
  if (config?.retention?.enabled) {
    const days = config.retention.days;
    return {
      enabled: true,
      text: `Automatic cleanup is ON — run transport older than ${days} days is removed to reclaim disk space. Accounting and reports are never touched. Change or disable: retention in run-config.json.`,
    };
  }
  return {
    enabled: false,
    text: 'Automatic cleanup is OFF — run transport is retained until manually pruned.',
  };
}

/**
 * A run gets a hard wall-clock budget, because the caller's timeout is not a run contract:
 * on 2026-08-03 one order restarted six times and spent 170,293 accounted tokens while four
 * killed callers left their Codex processes and token spend unrecorded.
 */
function readBudgets(file, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      `${file}: key “${BUDGET_KEY}” must be an object keyed by ${BUDGET_MODES.join(', ')}, ` +
        `each holding a positive number of minutes, not ${JSON.stringify(value)}`,
    );
  }
  const budgets = { ...DEFAULT_BUDGETS };
  for (const [mode, minutes] of Object.entries(value)) {
    if (!BUDGET_MODES.includes(mode)) {
      throw new Error(
        `${file}: key “${BUDGET_KEY}” has unknown mode “${mode}”. ` +
          `Only ${BUDGET_MODES.join(', ')} are allowed`,
      );
    }
    if (typeof minutes === 'string' && !minutes.trim()) {
      throw new Error(
        `${file}: key “${BUDGET_KEY}.${mode}” is empty; remove the field to use the default ` +
          `(${DEFAULT_BUDGETS[mode]} minutes), or give it a positive number of minutes`,
      );
    }
    if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) {
      throw new Error(
        `${file}: key “${BUDGET_KEY}.${mode}” must be a positive number of minutes, ` +
          `not ${JSON.stringify(minutes)}`,
      );
    }
    budgets[mode] = minutes;
  }
  return budgets;
}

export function readRunConfig(file = CONFIG_PATH) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { ...DEFAULTS };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${file} cannot be parsed as JSON (${err.message}). Fix or delete the file — without it, ` +
        'the default mode applies: hooks and plugins are disabled.',
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file} must contain an object like {"hooks": false, "plugins": false}`);
  }
  const config = { ...DEFAULTS };
  for (const [key, value] of Object.entries(parsed)) {
    if (!KEYS.includes(key)) {
      throw new Error(`${file}: unknown key “${key}”. Only ${KEYS.join(', ')} are allowed`);
    }
    if (STRING_KEYS.includes(key)) {
      if (typeof value !== 'string' || !value.trim()) {
        throw new Error(
          `${file}: key “${key}” must be a non-empty string, not ${JSON.stringify(value)}. ` +
            `Remove the key to keep the default (${DEFAULTS[key]}).`,
        );
      }
      config[key] = value.trim();
      continue;
    }
    if (key === BUDGET_KEY) {
      config[key] = readBudgets(file, value);
      continue;
    }
    if (key === RETENTION_KEY) {
      config[key] = readRetention(file, value);
      continue;
    }
    if (LIST_KEYS.includes(key)) {
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        throw new Error(
          `${file}: key “${key}” must be a list of string patterns, not ${JSON.stringify(value)}. ` +
            'An empty list means “the environment writes nothing”; an absent key uses the default.',
        );
      }
      config[key] = value.map((item) => item.trim()).filter(Boolean);
      continue;
    }
    if (OBJECT_KEYS.includes(key)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(
          `${file}: key “${key}” must be an object keyed by ${MODEL_KEYS.join(', ')}, ` +
            `each holding {"model": "...", "effort": "..."}, not ${JSON.stringify(value)}`,
        );
      }
      const models = {};
      for (const [mode, profile] of Object.entries(value)) {
        if (!MODEL_KEYS.includes(mode)) {
          throw new Error(
            `${file}: key “${key}” has unknown mode “${mode}”. Only ${MODEL_KEYS.join(', ')} are allowed`,
          );
        }
        if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
          throw new Error(
            `${file}: key “${key}.${mode}” must be an object like ` +
              `{"model": "...", "effort": "..."}, not ${JSON.stringify(profile)}`,
          );
        }
        const resolved = {};
        for (const [field, fieldValue] of Object.entries(profile)) {
          if (!PROFILE_KEYS.includes(field)) {
            throw new Error(
              `${file}: key “${key}.${mode}” has unknown field “${field}”. ` +
                `Only ${PROFILE_KEYS.join(', ')} are allowed`,
            );
          }
          if (typeof fieldValue !== 'string') {
            throw new Error(
              `${file}: key “${key}.${mode}.${field}” must be a string, not ${JSON.stringify(fieldValue)}`,
            );
          }
          const trimmed = fieldValue.trim();
          // A field written as an empty string is a mistake, not an absence: dropping it silently
          // would send the run to another profile's depth past every check below.
          if (!trimmed) {
            throw new Error(
              `${file}: key “${key}.${mode}.${field}” is empty; remove the field to fall back, ` +
                'or give it a value',
            );
          }
          resolved[field] = trimmed;
        }
        if (resolved.effort && /\s/.test(resolved.effort)) {
          throw new Error(
            `${file}: key “${key}.${mode}.effort” must be a single word; ` +
              `allowed values: ${ALLOWED_EFFORTS.join(', ')}`,
          );
        }
        if (resolved.effort && !ALLOWED_EFFORTS.includes(resolved.effort)) {
          throw new Error(
            `${file}: key “${key}.${mode}.effort” must be one of: ` +
              `${ALLOWED_EFFORTS.join(', ')}; got ${JSON.stringify(resolved.effort)}`,
          );
        }
        if (Object.keys(resolved).length) models[mode] = resolved;
      }
      config[key] = models;
      continue;
    }
    if (typeof value !== 'boolean') {
      throw new Error(`${file}: key “${key}” must be true or false, not ${JSON.stringify(value)}`);
    }
    config[key] = value;
  }
  return config;
}

export function writeRunConfig(config, file = CONFIG_PATH) {
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
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
  `models: ${MODEL_KEYS.map((key) => {
    const profile = config.models?.[key];
    if (!profile?.model && !profile?.effort) return `${key}: default — chosen by Codex`;
    const model = profile.model || 'default model';
    return `${key}: ${model}${profile.effort ? ` at ${profile.effort} effort` : ''}`;
  }).join('; ')}`,
  `budgets: ${BUDGET_MODES.map((mode) => `${mode}: ${config.budgets?.[mode] ?? DEFAULT_BUDGETS[mode]} minutes`).join('; ')}`,
  `retention: ${config.retention?.enabled ? `on — transport older than ${config.retention.days} days` : 'off — automatic cleanup disabled'}`,
];

function main(argv) {
  const [key, value] = argv;

  if (!key) {
    const config = readRunConfig();
    console.log([...state(config), `File: ${CONFIG_PATH}`].join('\n'));
    return 0;
  }

  if (key === 'reset') {
    writeRunConfig({ ...DEFAULTS });
    console.log([...state(DEFAULTS), `Reset to defaults · ${CONFIG_PATH}`].join('\n'));
    return 0;
  }

  if (!SWITCH_KEYS.includes(key)) {
    const known = LIST_KEYS.includes(key)
      ? `“${key}” is a pattern list, not a switch: edit it directly in ${CONFIG_PATH}`
      : OBJECT_KEYS.includes(key)
        ? `“${key}” is configured in the file, not as a switch: edit it directly in ${CONFIG_PATH}`
        : `unknown switch “${key}”. Allowed: ${SWITCH_KEYS.join(', ')}, reset`;
    console.error(`run-config: ${known}`);
    return 2;
  }
  if (value !== 'on' && value !== 'off') {
    console.error(`run-config: value must be on or off, received “${value ?? '(empty)'}”`);
    return 2;
  }

  const config = { ...readRunConfig(), [key]: value === 'on' };
  writeRunConfig(config);
  console.log([...state(config), `File: ${CONFIG_PATH}`].join('\n'));
  return 0;
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`run-config: ${err.message}`);
    process.exit(2);
  }
}
