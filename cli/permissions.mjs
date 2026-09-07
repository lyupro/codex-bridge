/** Manages the optional shell permission rules for every codex-bridge command spelling. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLI_NAMES } from '../src/home/lib/cli-names.mjs';
import { SHELL_TOOLS } from '../src/home/lib/hook-definitions.mjs';
import { readSettings, updateSettings, withSettingsRun } from './settings-merge.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entryPoint = fileURLToPath(new URL('../bin/codex-bridge.mjs', import.meta.url));
const nodeCommand = `node ${path.relative(packageRoot, entryPoint).split(path.sep).join('/')}`;
const commandNames = Object.freeze([...CLI_NAMES, nodeCommand]);
const formsFor = (command) => [command, `${command}:*`];

function buildRules(commandTransform) {
  return Object.freeze(SHELL_TOOLS.flatMap((tool) => commandNames.flatMap((command) =>
    formsFor(commandTransform(command)).map((form) => `${tool}(${form})`))));
}

/**
 * The executable names stay owned by cli-names.mjs; only the clone entry point is derived here.
 * Plan_22 records the incident because repeating the node spelling in CLI_NAMES would make the
 * source list answer two different questions and let a future alias bypass one of them.
 *
 * The deny half subtracts `prune` from the allow half rather than guarding it: `Bash(codex-bridge:*)`
 * would otherwise hand out the deletion this package refuses to give an agent. Plan_56's
 * 2026-09-07 reconnaissance established deny, ask, allow ordering before PreToolUse hooks:
 * the narrow speed ask therefore wins over the broad allow, and no hook can waive it.
 */
export const PERMISSION_RULES = Object.freeze({
  allow: buildRules((command) => command),
  deny: buildRules((command) => `${command} prune`),
  ask: buildRules((command) => `${command} model speed`),
});

const allRules = new Set(Object.values(PERMISSION_RULES).flat());
const ruleLists = Object.freeze(['allow', 'deny', 'ask']);
const activeLists = ruleLists;
const totalRules = allRules.size;

/**
 * Which lists a count covers, spelled once.
 *
 * Two sentences report that count — this module's own line and doctor's — and both used to name
 * the lists in prose. Adding `ask` in Plan_56 updated one and left the other saying `allow/deny`
 * over a number that already included the third list: a true number under a false label, which is
 * the same defect Plan_22-1 caught in this very line. Derived from the list of lists so a fourth
 * one cannot introduce a third spelling.
 */
export const RULE_LIST_NAMES = ruleLists.join('/');

function listValue(settings, name) {
  const list = settings?.permissions?.[name];
  return Array.isArray(list) ? list : [];
}

function matchingRules(list, rules) {
  return rules.filter((rule) => list.includes(rule)).length;
}

/**
 * A count of installed strings is not the state of the set, because `ask` outranks `allow`:
 * a copy sitting there keeps asking the question the rule was added to end. The live run of
 * Plan_22-1 caught doctor reporting `installed (24/24)` over exactly that arrangement — the number
 * was true and the conclusion drawn from it was false. Every consumer reads the state, so the
 * shadow has to live in the state rather than in one command's wording. Plan_56's own speed ask
 * rules are intentional; only allow strings copied into ask count as that shadow.
 */
function permissionStatus(settings) {
  const counts = Object.fromEntries(activeLists.map((name) => [
    name,
    matchingRules(listValue(settings, name), PERMISSION_RULES[name]),
  ]));
  const askCount = matchingRules(listValue(settings, 'ask'), PERMISSION_RULES.allow);
  const present = counts.allow + counts.deny + counts.ask;
  const complete = present === totalRules;
  const state = askCount
    ? (complete ? 'shadowed by ask' : 'partially installed, shadowed by ask')
    : complete ? 'installed' : present === 0 ? 'absent' : 'partially installed';
  return {
    state,
    complete,
    counts,
    askCount,
    present,
    total: totalRules,
  };
}

function ensureList(settings, name) {
  if (settings.permissions === undefined) settings.permissions = {};
  if (!settings.permissions || typeof settings.permissions !== 'object'
    || Array.isArray(settings.permissions)) {
    throw new TypeError('settings.permissions must be an object');
  }
  if (settings.permissions[name] === undefined) settings.permissions[name] = [];
  if (!Array.isArray(settings.permissions[name])) {
    throw new TypeError(`settings.permissions.${name} must be an array`);
  }
  return settings.permissions[name];
}

function countRemovable(settings) {
  return ruleLists.reduce((total, name) => total + listValue(settings, name)
    .filter((entry) => allRules.has(entry)).length, 0);
}

export async function inspectPermissions(settingsPath) {
  const state = await readSettings(settingsPath);
  return { ...state, ...permissionStatus(state.settings) };
}

export async function addPermissionRules(settingsPath) {
  return updateSettings(settingsPath, (settings) => {
    let added = 0;
    for (const name of activeLists) {
      const list = ensureList(settings, name);
      for (const rule of PERMISSION_RULES[name]) {
        if (list.includes(rule)) continue;
        list.push(rule);
        added += 1;
      }
    }
    const status = permissionStatus(settings);
    return {
      changed: added > 0,
      added,
      present: status.present,
      total: status.total,
    };
  });
}

export async function removePermissionRules(settingsPath, { dryRun = false } = {}) {
  if (dryRun) {
    const state = await readSettings(settingsPath);
    return { changed: false, removed: countRemovable(state.settings) };
  }
  return updateSettings(settingsPath, (settings) => {
    let removed = 0;
    for (const name of ruleLists) {
      const list = settings?.permissions?.[name];
      if (!Array.isArray(list)) continue;
      settings.permissions[name] = list.filter((entry) => {
        if (!allRules.has(entry)) return true;
        removed += 1;
        return false;
      });
    }
    return { changed: removed > 0, removed };
  });
}

function statusOutput(status, action) {
  const moved = status.askCount && action !== 'add'
    ? `; ${status.askCount} own string(s) in ask, which outranks allow`
    : '';
  return `Permissions: ${status.state} (${status.present}/${status.total} own strings in ${RULE_LIST_NAMES}${moved}).`;
}

async function permissionsInRun({ host, action } = {}) {
  if (!host?.settingsPath) throw new TypeError('permissions requires a resolved host');
  if (!action) {
    const status = await inspectPermissions(host.settingsPath);
    return { exitCode: 0, output: statusOutput(status, action), ...status };
  }
  if (action === 'add') {
    const result = await addPermissionRules(host.settingsPath);
    // A string the operator moved into `ask` outranks the copy `add` just put into `allow`, so the
    // command would report a complete set while the questions it was run to end keep appearing.
    // That allow string stays in `ask` — it is a hand-made decision — alongside our speed rules.
    const status = await inspectPermissions(host.settingsPath);
    const conflict = status.askCount
      ? ` ${status.askCount} own string(s) also sit in ask, which outranks allow; they were left there.`
      : '';
    // The 2026-09-07, 0.6.0 install incident mistook a zero delta for failure; report the set too.
    const added = result.added > 0
      ? `Added ${result.added} permission rule string${result.added === 1 ? '' : 's'}. `
      : '';
    return {
      exitCode: 0,
      output: `${added}${statusOutput(status, action)}${conflict}`,
      ...result,
      askCount: status.askCount,
    };
  }
  if (action === 'remove') {
    const result = await removePermissionRules(host.settingsPath);
    return {
      exitCode: 0,
      output: `Removed ${result.removed} permission rule string${result.removed === 1 ? '' : 's'}.`,
      ...result,
    };
  }
  throw new Error(`unknown permissions action "${action}"`);
}

export async function permissions(options = {}) {
  const host = options?.host;
  if (!host?.settingsPath) return permissionsInRun(options);
  return withSettingsRun(host.settingsPath, () => permissionsInRun(options));
}
