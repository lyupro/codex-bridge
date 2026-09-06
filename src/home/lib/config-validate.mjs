/** Shared by reading and editing so Plan_56 D27 cannot persist an unreadable config. */
import { AGENTS } from './agents.mjs';

const BUDGET_KEY = 'budgets';
export const ROLES = Object.values(AGENTS).map(({ role }) => role);
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
  budgets: Object.fromEntries(Object.values(AGENTS).map(({ role, budget }) => [role, budget])),
  retention: DEFAULT_RETENTION,
  environmentPaths: DEFAULT_ENVIRONMENT_PATHS,
  answerLanguage: 'English',
};

/** Booleans the operator flips from the command line; structured keys are edited in the file. */
export const SWITCH_KEYS = ['hooks', 'plugins'];
export const LIST_KEYS = ['environmentPaths'];
export const OBJECT_KEYS = ['models'];
/**
 * A role is configured as a pair, not as a model alone: reasoning depth is half of what a
 * model is worth. A cheap model at its default depth is a different worker from the same
 * model at "max", and pinning only the name would have silently kept every run at the
 * fallback depth the dispatcher happens to pass.
 */
const PROFILE_KEYS = ['model', 'effort'];
// Exactly the values the service enumerates, and no more. `minimal` sat here until 2026-08-26,
// passed validation and was rejected by the model itself after the run had started
// ("Unsupported value: 'minimal' is not supported with the … model"), so an order died four
// seconds in on quota already spent. A validator that admits a known-dead value is worse than none.
export const ALLOWED_EFFORTS = Object.freeze(['none', 'low', 'medium', 'high', 'xhigh', 'max']);
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

/**
 * A run gets a hard wall-clock budget, because the caller's timeout is not a run contract:
 * on 2026-08-03 one order restarted six times and spent 170,293 accounted tokens while four
 * killed callers left their Codex processes and token spend unrecorded.
 */
function readBudgets(file, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      `${file}: key “${BUDGET_KEY}” must be an object keyed by ${ROLES.join(', ')}, ` +
        `each holding a positive number of minutes, not ${JSON.stringify(value)}`,
    );
  }
  const budgets = { ...DEFAULTS.budgets };
  for (const [role, minutes] of Object.entries(value)) {
    if (!ROLES.includes(role)) {
      throw new Error(
        `${file}: key “${BUDGET_KEY}” has unknown role “${role}”. ` +
          `Only ${ROLES.join(', ')} are allowed`,
      );
    }
    if (typeof minutes === 'string' && !minutes.trim()) {
      throw new Error(
        `${file}: key “${BUDGET_KEY}.${role}” is empty; remove the field to use the default ` +
          `(${DEFAULTS.budgets[role]} minutes), or give it a positive number of minutes`,
      );
    }
    if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) {
      throw new Error(
        `${file}: key “${BUDGET_KEY}.${role}” must be a positive number of minutes, ` +
          `not ${JSON.stringify(minutes)}`,
      );
    }
    budgets[role] = minutes;
  }
  return budgets;
}

export function validateRunConfig(file, parsed) {
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
          `${file}: key “${key}” must be an object keyed by ${ROLES.join(', ')}, ` +
            `each holding {"model": "...", "effort": "..."}, not ${JSON.stringify(value)}`,
        );
      }
      const models = {};
      for (const [role, profile] of Object.entries(value)) {
        if (!ROLES.includes(role)) {
          throw new Error(
            `${file}: key “${key}” has unknown role “${role}”. Only ${ROLES.join(', ')} are allowed`,
          );
        }
        if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
          throw new Error(
            `${file}: key “${key}.${role}” must be an object like ` +
              `{"model": "...", "effort": "..."}, not ${JSON.stringify(profile)}`,
          );
        }
        const resolved = {};
        for (const [field, fieldValue] of Object.entries(profile)) {
          if (!PROFILE_KEYS.includes(field)) {
            throw new Error(
              `${file}: key “${key}.${role}” has unknown field “${field}”. ` +
                `Only ${PROFILE_KEYS.join(', ')} are allowed`,
            );
          }
          if (typeof fieldValue !== 'string') {
            throw new Error(
              `${file}: key “${key}.${role}.${field}” must be a string, not ${JSON.stringify(fieldValue)}`,
            );
          }
          const trimmed = fieldValue.trim();
          // A field written as an empty string is a mistake, not an absence: dropping it silently
          // would send the run to another profile's depth past every check below.
          if (!trimmed) {
            throw new Error(
              `${file}: key “${key}.${role}.${field}” is empty; remove the field to fall back, ` +
                'or give it a value',
            );
          }
          resolved[field] = trimmed;
        }
        if (resolved.effort && /\s/.test(resolved.effort)) {
          throw new Error(
            `${file}: key “${key}.${role}.effort” must be a single word; ` +
              `allowed values: ${ALLOWED_EFFORTS.join(', ')}`,
          );
        }
        if (resolved.effort && !ALLOWED_EFFORTS.includes(resolved.effort)) {
          throw new Error(
            `${file}: key “${key}.${role}.effort” must be one of: ` +
              `${ALLOWED_EFFORTS.join(', ')}; got ${JSON.stringify(resolved.effort)}`,
          );
        }
        if (Object.keys(resolved).length) models[role] = resolved;
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

