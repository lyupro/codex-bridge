/** Writes only the requested role; Plan_56 step 3 validates its pair before the shared edit. */
import path from 'node:path';
import { CONFIG_PATH } from '../src/home/lib/run-config.mjs';
import { ROLES, validateRunConfig } from '../src/home/lib/config-validate.mjs';
import { readJsonFileSync } from '../src/home/lib/json-file.mjs';
import { editRunConfig } from '../src/home/lib/config-edit.mjs';
import { fetchCatalogue, parseCatalogue } from './model-catalogue.mjs';

const failure = (exitCode, message) => ({ exitCode, output: `codex-bridge model: ${message}` });

function parseChanges(args) {
  const changes = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    let field;
    let value = argument;
    if (argument.startsWith('-')) {
      if (argument !== '--model' && argument !== '--effort') {
        throw new Error(`unexpected argument "${argument}".`);
      }
      field = argument.slice(2);
      value = args[++index];
      if (value === undefined || value.startsWith('-')) throw new Error(`missing value for ${argument}.`);
    } else {
      field = ['model', 'effort'].find((key) => changes[key] === undefined);
      if (!field) throw new Error(`unexpected argument "${argument}".`);
    }
    if (changes[field] !== undefined) throw new Error(`${field} was supplied more than once.`);
    if (!value || /\s/.test(value)) {
      throw new Error(`${field} must be a non-empty single word with no whitespace.`);
    }
    changes[field] = value;
  }
  if (!Object.keys(changes).length) throw new Error('set requires a model or --effort value.');
  return changes;
}

function readProfiles(configPath) {
  let config;
  try {
    config = readJsonFileSync(configPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    config = {};
  }
  validateRunConfig(configPath, config);
  // The reader trims fields and drops empty profiles. Those are not edits the operator asked for.
  return { ...config.models };
}

// The same sentence the config module already prints for a profile. A serialized object here
// would be the second spelling of one idea, and the operator reading it is a person, not a parser.
function describe(profile) {
  if (!profile || !Object.keys(profile).length) return 'not set (Codex chooses)';
  const model = profile.model || 'default model';
  return profile.effort ? `${model} at ${profile.effort} effort` : model;
}

export async function editModelProfile(action, argv, options) {
  const [role, ...args] = argv;
  if (!ROLES.includes(role)) {
    return failure(2, `${role ? `unknown role "${role}"` : 'role is required'}. Allowed roles: ${ROLES.join(', ')}.`);
  }
  let changes;
  try {
    if (action === 'unset' && args.length) throw new Error(`unexpected argument "${args[0]}".`);
    if (action === 'set') changes = parseChanges(args);
  } catch (error) {
    return failure(2, error.message);
  }

  try {
    const configPath = path.resolve(options.configPath ?? CONFIG_PATH);
    let catalogue;
    if (action === 'set') {
      try {
        catalogue = parseCatalogue(await (options.fetchCatalogue ?? fetchCatalogue)());
      } catch (error) {
        return failure(1, `live catalogue unavailable; refusing to set ${role}: ${error?.message ?? String(error)}`);
      }
    }
    // Fetching can take seconds; use the current profiles so edits made during that wait survive.
    const profiles = readProfiles(configPath);
    const before = profiles[role];
    let hiddenNotice = '';
    if (action === 'set') {
      const after = { ...before, ...changes };
      const modelId = after.model?.trim();
      const effort = after.effort?.trim();
      if (!modelId) return failure(2, `${role} has no configured model; supply a model or --model.`);
      const entry = catalogue.find(({ slug }) => slug === modelId);
      if (!entry) {
        return failure(2, `unknown model "${after.model}". Available models: ${catalogue.map(({ slug }) => slug).join(', ') || '(empty catalogue)'}. Nothing written.`);
      }
      if (effort !== undefined && !entry.supportedReasoningLevels.includes(effort)) {
        const origin = changes.effort === undefined ? 'existing effort' : 'effort';
        return failure(2, `${origin} "${after.effort}" is not supported by model "${after.model}". `
          + `Supported depths: ${entry.supportedReasoningLevels.join(', ') || '(no depths advertised)'}. `
          + 'Supply a supported effort explicitly. Nothing written.');
      }
      if (entry.hidden) hiddenNotice = `Model "${entry.slug}" is hidden in the Codex catalogue.\n`;
      profiles[role] = after;
    } else {
      delete profiles[role];
    }
    await editRunConfig({ key: 'models', value: profiles }, configPath);
    return {
      exitCode: 0,
      output: `${hiddenNotice}${role}: ${describe(before)} -> ${describe(profiles[role])}\nConfig file: ${configPath}\n`
        + 'Machine-wide: shared by every project on this machine, not per-project.',
    };
  } catch (error) {
    return failure(1, `cannot ${action} profile: ${error?.message ?? String(error)}`);
  }
}
