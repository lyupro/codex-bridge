/** Plan_56 step 4: paid tiers are catalogue decisions applied only by an explicit second call. */
import path from 'node:path';
import { CONFIG_PATH } from '../src/home/lib/run-config.mjs';
import { ROLES, validateRunConfig } from '../src/home/lib/config-validate.mjs';
import { editRunConfig } from '../src/home/lib/config-edit.mjs';
import { fetchCatalogue, parseCatalogue } from './model-catalogue.mjs';
import { describe, readProfiles } from './model-set.mjs';

const failure = (exitCode, message) => ({ exitCode, output: `codex-bridge model: ${message}` });
const refusal = (message) => Object.assign(new Error(message), { exitCode: 2 });

export async function editModelSpeed(argv, options) {
  const [role, speed, confirmation, ...extra] = argv;
  if (!ROLES.includes(role)) {
    return failure(2, `${role ? `unknown role "${role}"` : 'role is required'}. Allowed roles: ${ROLES.join(', ')}.`);
  }
  if (typeof speed !== 'string' || !speed || /\s/.test(speed)) {
    return failure(2, 'speed requires a tier identifier: a non-empty single word with no whitespace, or unset.');
  }
  if (confirmation !== undefined && (speed === 'unset' || confirmation !== 'confirm')) {
    return failure(2, `unexpected argument "${confirmation}".`);
  }
  if (extra.length) return failure(2, `unexpected argument "${extra[0]}".`);

  try {
    const configPath = path.resolve(options.configPath ?? CONFIG_PATH);
    let catalogue;
    let tier;
    if (speed !== 'unset') {
      if (!readProfiles(configPath)[role]?.model) {
        return failure(2, `${role} has no configured model; run model set ${role} <model> first. Nothing written.`);
      }
      try {
        catalogue = parseCatalogue(await (options.fetchCatalogue ?? fetchCatalogue)());
      } catch (error) {
        return failure(1, `live catalogue unavailable; refusing to set ${role} speed: ${error?.message ?? String(error)}`);
      }
    }

    let change;
    let catalogueModel;
    const transform = (current) => {
      // Same absent-key rule as model-set: a missing config still answers about the role.
      if (current !== undefined) validateRunConfig(configPath, { models: current });
      const profiles = { ...current };
      if (speed !== 'unset') {
        const modelId = profiles[role]?.model?.trim();
        // D40/D41: reusing a tier decision after a role changes model would validate the wrong pair.
        if (catalogueModel !== undefined && modelId !== catalogueModel) {
          throw new Error('The profile changed while the catalogue was being read; nothing was written. Run the command again.');
        }
        if (!modelId) {
          throw refusal(`${role} has no configured model; run model set ${role} <model> first. Nothing written.`);
        }
        const entry = catalogue.find(({ slug }) => slug === modelId);
        if (!entry) {
          throw refusal(`unknown model "${modelId}". Available models: ${catalogue.map(({ slug }) => slug).join(', ') || '(empty catalogue)'}. Nothing written.`);
        }
        if (!entry.serviceTiers.length) {
          throw refusal(`model "${modelId}" has no accelerated tier. Nothing written.`);
        }
        tier = entry.serviceTiers.find(({ id }) => id === speed);
        if (!tier) {
          throw refusal(`speed "${speed}" is not supported by model "${modelId}". `
            + `Accelerated tiers: ${entry.serviceTiers.map(({ id }) => id).join(', ')}. Nothing written.`);
        }
        catalogueModel = entry.slug;
      }
      const before = profiles[role];
      const after = { ...before };
      if (speed === 'unset') delete after.speed;
      else after.speed = speed;
      change = `${role}: ${describe(before)} -> ${describe(after)}`;
      if (before || speed !== 'unset') profiles[role] = after;
      return profiles;
    };
    if (speed !== 'unset' && confirmation !== 'confirm') {
      transform(readProfiles(configPath));
      return {
        exitCode: 0,
        output: `Preview — ${change}\nCatalogue description: "${tier.description}"\n`
          + 'Credit multipliers: https://learn.chatgpt.com/docs/agent-configuration/speed\n'
          + `Run a second call ending in confirm to apply: codex-bridge model speed ${role} ${speed} confirm\nNothing written.`,
      };
    }
    await editRunConfig('models', transform, configPath);
    return {
      exitCode: 0,
      output: `${change}\nConfig file: ${configPath}\n`
        + 'Machine-wide: shared by every project on this machine, not per-project.',
    };
  } catch (error) {
    if (error.exitCode === 2) return failure(2, error.message);
    return failure(1, `cannot ${speed === 'unset' ? 'unset' : 'set'} speed: ${error?.message ?? String(error)}`);
  }
}
