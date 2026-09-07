/** Plan_56 step 4: paid tiers are catalogue decisions applied only by an explicit second call. */
import path from 'node:path';
import { CONFIG_PATH } from '../src/home/lib/run-config.mjs';
import { ROLES } from '../src/home/lib/config-validate.mjs';
import { editRunConfig } from '../src/home/lib/config-edit.mjs';
import { fetchCatalogue, parseCatalogue } from './model-catalogue.mjs';
import { describe, readProfiles } from './model-set.mjs';

const failure = (exitCode, message) => ({ exitCode, output: `codex-bridge model: ${message}` });

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
    let profiles = readProfiles(configPath);
    let tier;
    if (speed !== 'unset') {
      if (!profiles[role]?.model) {
        return failure(2, `${role} has no configured model; run model set ${role} <model> first. Nothing written.`);
      }
      let catalogue;
      try {
        catalogue = parseCatalogue(await (options.fetchCatalogue ?? fetchCatalogue)());
      } catch (error) {
        return failure(1, `live catalogue unavailable; refusing to set ${role} speed: ${error?.message ?? String(error)}`);
      }
      // Plan_56: a profile edited during the catalogue wait must be checked and preserved too.
      profiles = readProfiles(configPath);
      const modelId = profiles[role]?.model?.trim();
      if (!modelId) {
        return failure(2, `${role} has no configured model; run model set ${role} <model> first. Nothing written.`);
      }
      const entry = catalogue.find(({ slug }) => slug === modelId);
      if (!entry) {
        return failure(2, `unknown model "${modelId}". Available models: ${catalogue.map(({ slug }) => slug).join(', ') || '(empty catalogue)'}. Nothing written.`);
      }
      if (!entry.serviceTiers.length) {
        return failure(2, `model "${modelId}" has no accelerated tier. Nothing written.`);
      }
      tier = entry.serviceTiers.find(({ id }) => id === speed);
      if (!tier) {
        return failure(2, `speed "${speed}" is not supported by model "${modelId}". `
          + `Accelerated tiers: ${entry.serviceTiers.map(({ id }) => id).join(', ')}. Nothing written.`);
      }
    }

    const before = profiles[role];
    const after = { ...before };
    if (speed === 'unset') delete after.speed;
    else after.speed = speed;
    const change = `${role}: ${describe(before)} -> ${describe(after)}`;
    if (speed !== 'unset' && confirmation !== 'confirm') {
      return {
        exitCode: 0,
        output: `Preview — ${change}\nCatalogue description: "${tier.description}"\n`
          + 'Credit multipliers: https://learn.chatgpt.com/docs/agent-configuration/speed\n'
          + `Run a second call ending in confirm to apply: codex-bridge model speed ${role} ${speed} confirm\nNothing written.`,
      };
    }
    if (before || speed !== 'unset') profiles[role] = after;
    await editRunConfig({ key: 'models', value: profiles }, configPath);
    return {
      exitCode: 0,
      output: `${change}\nConfig file: ${configPath}\n`
        + 'Machine-wide: shared by every project on this machine, not per-project.',
    };
  } catch (error) {
    return failure(1, `cannot ${speed === 'unset' ? 'unset' : 'set'} speed: ${error?.message ?? String(error)}`);
  }
}
