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
  environmentPaths: DEFAULT_ENVIRONMENT_PATHS,
};

/** Booleans the operator flips from the command line; the list key is edited in the file. */
const SWITCH_KEYS = ['hooks', 'plugins'];
const LIST_KEYS = ['environmentPaths'];
const KEYS = [...SWITCH_KEYS, ...LIST_KEYS];

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
