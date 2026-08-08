#!/usr/bin/env node
/**
 * Enforces the repository's "source file <= maxLines" rule as a pre-commit gate: reads
 * .file-size-limit.json, globs every included file, counts its lines, and reports (or
 * blocks, in error mode) any file over the limit that is not covered by a documented
 * exclusion.
 *
 *   node scripts/check-file-size.mjs             # honor mode from the config file
 *   node scripts/check-file-size.mjs --error      # force error mode regardless of config
 *   node scripts/check-file-size.mjs --json       # machine-readable output for CI
 *
 * Exit codes: 0 clean (or violations found but mode is "warning"), 1 violations found in
 * error mode, 2 internal error (config missing/malformed, or an exclude entry has no
 * matching exclusionRationale).
 *
 * Every exclude entry is classified as either a "pattern" (contains a `*`, sweeps a
 * whole category — e.g. `**\/node_modules/**`) or a "specific path" (no `*`, names one
 * file). Specific paths must carry an exclusionRationale entry; patterns are exempt. This
 * is the structural guard against silently hiding a file in exclude without saying why.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonFile } from '../src/json-file.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..');
export const CONFIG_PATH = path.join(REPO_ROOT, '.file-size-limit.json');

const REQUIRED_KEYS = ['maxLines', 'mode', 'include', 'exclude', 'baselineDate', 'exclusionRationale'];
const VALID_MODES = ['error', 'warning'];

/** Reads and structurally validates .file-size-limit.json. Throws on anything wrong. */
export async function loadConfig(configPath = CONFIG_PATH) {
  let parsed;
  try {
    parsed = await readJsonFile(configPath);
  } catch (err) {
    if (err.cause) {
      throw new Error(`${configPath} is not valid JSON: ${err.cause.message}`, { cause: err.cause });
    }
    throw new Error(`cannot read ${configPath}: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${configPath} must contain a JSON object`);
  }
  for (const key of REQUIRED_KEYS) {
    if (!(key in parsed)) {
      throw new Error(`${configPath} is missing required key "${key}"`);
    }
  }
  if (!Number.isInteger(parsed.maxLines) || parsed.maxLines <= 0) {
    throw new Error(`${configPath}: "maxLines" must be a positive integer`);
  }
  if (!VALID_MODES.includes(parsed.mode)) {
    throw new Error(`${configPath}: "mode" must be one of ${VALID_MODES.join(', ')}`);
  }
  if (!Array.isArray(parsed.include) || !parsed.include.every((p) => typeof p === 'string')) {
    throw new Error(`${configPath}: "include" must be an array of glob strings`);
  }
  if (!Array.isArray(parsed.exclude) || !parsed.exclude.every((p) => typeof p === 'string')) {
    throw new Error(`${configPath}: "exclude" must be an array of glob strings`);
  }
  if (typeof parsed.exclusionRationale !== 'object' || parsed.exclusionRationale === null || Array.isArray(parsed.exclusionRationale)) {
    throw new Error(`${configPath}: "exclusionRationale" must be an object`);
  }
  return parsed;
}

/** A pattern (contains `*`) sweeps a category; a specific path (no `*`) names one file. */
export function isSpecificExclude(entry) {
  return !entry.includes('*');
}

/** Throws if any specific-path exclude lacks a matching exclusionRationale entry. */
export function validateExclusionRationale(config) {
  const missing = config.exclude
    .filter(isSpecificExclude)
    .filter((entry) => !Object.prototype.hasOwnProperty.call(config.exclusionRationale, entry));
  if (missing.length) {
    throw new Error(
      `.file-size-limit.json: exclude entries with no exclusionRationale: ${missing.join(', ')}. ` +
        'Every specific-path exclusion needs a documented reason, not a silent bypass.',
    );
  }
}

/** Globs every include pattern under rootDir, applying exclude, deduped and sorted. */
export async function collectFiles(config, rootDir = REPO_ROOT) {
  const seen = new Set();
  for (const pattern of config.include) {
    for await (const relPath of fs.glob(pattern, { cwd: rootDir, exclude: config.exclude })) {
      seen.add(relPath.split(path.sep).join('/'));
    }
  }
  return [...seen].sort();
}

/** Line count of one file, counted the same way as the rest of this repo: split('\n').length. */
export async function countLines(rootDir, relPath) {
  const content = await fs.readFile(path.join(rootDir, relPath), 'utf8');
  return content.split('\n').length;
}

/** Collects and measures every included file, returning the ones over the limit. */
export async function findViolators(config, rootDir = REPO_ROOT) {
  const files = await collectFiles(config, rootDir);
  const violators = [];
  for (const relPath of files) {
    const lines = await countLines(rootDir, relPath);
    if (lines > config.maxLines) {
      violators.push({ path: relPath, lines, limit: config.maxLines });
    }
  }
  return { filesChecked: files.length, violators };
}

function renderTable(violators) {
  const pathWidth = Math.max(4, ...violators.map((v) => v.path.length));
  const header = `${'FILE'.padEnd(pathWidth)}  LINES  LIMIT`;
  const rows = violators.map(
    (v) => `${v.path.padEnd(pathWidth)}  ${String(v.lines).padStart(5)}  ${String(v.limit).padStart(5)}`,
  );
  return [header, ...rows].join('\n');
}

/**
 * Runs the gate end to end and returns a result instead of exiting, so both the CLI
 * entry point and the test suite can drive the same logic.
 */
export async function run({ argv = [], rootDir = REPO_ROOT, configPath = CONFIG_PATH } = {}) {
  const forceError = argv.includes('--error');
  const asJson = argv.includes('--json');

  let config;
  try {
    config = await loadConfig(configPath);
    validateExclusionRationale(config);
  } catch (err) {
    return { exitCode: 2, output: `check-file-size: ${err.message}`, toStderr: true };
  }

  let result;
  try {
    result = await findViolators(config, rootDir);
  } catch (err) {
    return { exitCode: 2, output: `check-file-size: ${err.message}`, toStderr: true };
  }

  const effectiveMode = forceError ? 'error' : config.mode;
  const hasViolations = result.violators.length > 0;
  const exitCode = hasViolations && effectiveMode === 'error' ? 1 : 0;

  if (asJson) {
    const payload = {
      maxLines: config.maxLines,
      mode: effectiveMode,
      filesChecked: result.filesChecked,
      violators: result.violators,
    };
    return { exitCode, output: JSON.stringify(payload, null, 2), toStderr: false };
  }

  if (!hasViolations) {
    return {
      exitCode,
      output: `check-file-size: ${result.filesChecked} file(s) checked, all within ${config.maxLines} lines`,
      toStderr: false,
    };
  }

  const suffix = effectiveMode === 'warning' ? ' (warning mode — not blocking)' : '';
  const output = `${renderTable(result.violators)}\n\n${result.violators.length} file(s) exceed ${config.maxLines} lines${suffix}`;
  return { exitCode, output, toStderr: false };
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  run({ argv: process.argv.slice(2) })
    .then(({ exitCode, output, toStderr }) => {
      if (toStderr) console.error(output);
      else console.log(output);
      process.exit(exitCode);
    })
    .catch((err) => {
      console.error(`check-file-size: ${err.message}`);
      process.exit(2);
    });
}
