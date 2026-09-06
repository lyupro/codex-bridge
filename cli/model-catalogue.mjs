/** Fetches and validates the raw Codex catalogue for Plan_56 step 2. */
import { spawnSync } from 'node:child_process';
import { parseJsonText } from '../src/home/lib/json-file.mjs';

export function fetchCatalogue({ run = spawnSync } = {}) {
  const command = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'codex';
  const args = process.platform === 'win32'
    ? ['/d', '/s', '/c', 'codex debug models'] : ['debug', 'models'];
  // Plan_56: each invocation asks Codex again; its bundled catalogue is not live availability.
  const result = run(command, args, {
    encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
  });
  // Plan_56: Codex can emit bundled JSON with status 0 after reporting a refresh failure.
  const refreshFailed = /failed to refresh available models/i.test(result.stderr || '');
  if (result.error || result.signal || result.status !== 0 || refreshFailed) {
    const cause = [
      result.error && `${result.error.code || 'process error'}: ${result.error.message}`,
      result.stderr?.trim(),
      result.signal && `signal ${result.signal}`,
      result.status != null && `exit code ${result.status}`,
    ].filter(Boolean).join('; ');
    throw new Error(`codex debug models failed: ${cause || 'no process exit status'}`);
  }
  return result.stdout;
}

function textField(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`codex debug models: ${field} must be a non-empty string`);
  }
  return value;
}

function listField(value, field) {
  if (!Array.isArray(value)) throw new Error(`codex debug models: ${field} must be an array`);
  return value;
}

function catalogueRow(entry, index) {
  const field = `models[${index}]`;
  const slug = textField(entry?.slug, `${field}.slug`);
  const levels = listField(entry.supported_reasoning_levels, `${field}.supported_reasoning_levels`)
    .map((level, position) => textField(level?.effort, `${field}.supported_reasoning_levels[${position}].effort`));
  const defaultLevel = entry.default_reasoning_level == null
    ? 'not specified' : textField(entry.default_reasoning_level, `${field}.default_reasoning_level`);
  const visibility = textField(entry.visibility, `${field}.visibility`);
  if (!['list', 'hide', 'none'].includes(visibility)) {
    throw new Error(`codex debug models: ${field}.visibility is unknown: ${visibility}`);
  }
  const speedTiers = entry.additional_speed_tiers === undefined ? []
    : listField(entry.additional_speed_tiers, `${field}.additional_speed_tiers`)
      .map((tier, position) => textField(tier, `${field}.additional_speed_tiers[${position}]`));
  const serviceTiers = entry.service_tiers === undefined ? []
    : listField(entry.service_tiers, `${field}.service_tiers`)
      .map((tier, position) => textField(tier?.id, `${field}.service_tiers[${position}].id`));
  // Anything the catalogue offers beyond the ordinary tier is acceleration, named or not. Listing
  // the accepted spellings was already wrong about one: the documentation calls the switch `fast`
  // while the catalogue calls the tier `priority`, so the next tier to appear would read as "no"
  // on a model that has it. Only `default` is excluded, because it is the ordinary speed rather
  // than an offer — and a model with nothing else, as gpt-5.4-mini and gpt-5.3-codex-spark have,
  // is exactly how the catalogue says acceleration is unavailable.
  const fastTiers = [...new Set([
    ...speedTiers,
    ...serviceTiers.filter((tier) => tier !== 'default'),
  ])];
  return {
    slug,
    supportedReasoningLevels: levels,
    hidden: visibility !== 'list',
    'reasoning levels': levels.length ? levels.join(', ') : 'not specified',
    'default level': defaultLevel,
    'fast tier': fastTiers.length ? `yes (${fastTiers.join(', ')})` : 'no',
    visibility: visibility === 'list' ? 'listed' : `hidden (${visibility})`,
  };
}

export function parseCatalogue(json) {
  // Through the shared reader, not JSON.parse: one place strips the byte-order mark and names the
  // source in the error, and a gate keeps every module on it. The "file" here is the command whose
  // output failed, which is what the operator needs to see.
  const catalogue = parseJsonText('codex debug models', json);
  // Plan_56: invalid metadata refuses the whole list instead of silently dropping working models.
  return listField(catalogue?.models, 'models').map(catalogueRow);
}
