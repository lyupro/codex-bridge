/** Shows and edits machine-wide delegated profiles using the live catalogue (Plan_56). */
import path from 'node:path';
import { AGENTS } from '../src/home/lib/agents.mjs';
import { CONFIG_PATH, readRunConfig } from '../src/home/lib/run-config.mjs';
import { runProfile } from '../src/home/lib/runner/codex-args.mjs';
import { fetchCatalogue, parseCatalogue } from './model-catalogue.mjs';
import { editModelProfile } from './model-set.mjs';
import { editModelSpeed } from './model-speed.mjs';
import { renderTable } from './table.mjs';

const PROFILE_COLUMNS = ['role', 'model', 'effort', 'speed', 'source']
  .map((key) => ({ key, header: key, fixed: true }));
const CATALOGUE_COLUMNS = ['slug', 'reasoning levels', 'default level', 'fast tier', 'visibility']
  .map((key) => ({ key, header: key, fixed: true }));

// An unpinned model is not a default this package supplies — Codex picks one, and saying
// "built-in default" would credit the package with a choice it never made. The three cases stay
// three, because provenance is half of what this command exists to answer.
const MODEL_SOURCE = { config: 'config file' };
const EFFORT_SOURCE = { config: 'config file', request: 'this run' };

function profileSource(profile) {
  const model = MODEL_SOURCE[profile.model_source] ?? 'not set (Codex chooses)';
  const effort = EFFORT_SOURCE[profile.effort_source] ?? 'package default';
  return model === effort ? model : `model: ${model}; effort: ${effort}`;
}

/** Returns output for the dispatcher; explicit edit actions use the shared config writer. */
export async function model(argv = [], options = {}) {
  let action;
  let optionArgs = argv;
  if (argv[0] && !argv[0].startsWith('-')) {
    action = argv[0];
    optionArgs = argv.slice(1);
  }
  if (action === 'set' || action === 'unset') {
    return editModelProfile(action, optionArgs, options);
  }
  if (action === 'speed') return editModelSpeed(optionArgs, options);
  if (action && action !== 'list') {
    return { exitCode: 2, output: `codex-bridge model: unknown action "${action}". Use model, model list, model set, model unset or model speed.` };
  }
  if (optionArgs.length) {
    return { exitCode: 2, output: `codex-bridge model: unexpected argument "${optionArgs[0]}".` };
  }

  try {
    if (action === 'list') {
      const rows = parseCatalogue(await (options.fetchCatalogue ?? fetchCatalogue)());
      return {
        exitCode: 0,
        output: renderTable(CATALOGUE_COLUMNS, rows, options.terminalWidth)
          + (rows.length ? '' : '\nNo models returned by the live catalogue.'),
      };
    }

    const configPath = path.resolve(options.configPath ?? CONFIG_PATH);
    const config = readRunConfig(configPath);
    const rows = Object.entries(AGENTS).map(([agent, { role }]) => {
      const profile = runProfile({ agent, models: config.models });
      return {
        role,
        model: profile.model || 'Codex default (not pinned)',
        effort: profile.effort,
        speed: config.models[role]?.speed || 'not pinned',
        source: profileSource(profile),
      };
    });
    return {
      exitCode: 0,
      output: `${renderTable(PROFILE_COLUMNS, rows, options.terminalWidth)}\n\nConfig file: ${configPath}\n`
        + 'Machine-wide: shared by every project on this machine, not per-project.',
    };
  } catch (error) {
    const subject = action === 'list' ? 'live catalogue unavailable; refusing to list models' : 'cannot read profile';
    return { exitCode: 1, output: `codex-bridge model: ${subject}: ${error?.message ?? String(error)}` };
  }
}
