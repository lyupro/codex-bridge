/** Manages the optional shell permission rules for every codex-bridge command spelling. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLI_NAMES } from '../src/cli-names.mjs';
import { SHELL_TOOLS } from '../src/hook-definitions.mjs';
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
 * would otherwise hand out the deletion this package refuses to give an agent. Its refusal is never
 * seen in a live session — a PreToolUse hook answers before permissions are consulted, and
 * prune-guard is installed always while these rules are optional. The 2026-08-09 run held that
 * observation open as a checklist item until it turned out to be the answer, not the obstacle.
 */
export const PERMISSION_RULES = Object.freeze({
  allow: buildRules((command) => command),
  deny: buildRules((command) => `${command} prune`),
});

const allRules = new Set([...PERMISSION_RULES.allow, ...PERMISSION_RULES.deny]);
const ruleLists = Object.freeze(['allow', 'deny', 'ask']);
const activeLists = Object.freeze(['allow', 'deny']);
const totalRules = PERMISSION_RULES.allow.length + PERMISSION_RULES.deny.length;

function listValue(settings, name) {
  const list = settings?.permissions?.[name];
  return Array.isArray(list) ? list : [];
}

function matchingRules(list, rules) {
  return rules.filter((rule) => list.includes(rule)).length;
}

/**
 * A count of strings in allow and deny is not the state of the set, because `ask` outranks `allow`:
 * a copy sitting there keeps asking the question the rule was added to end. The live run of
 * Plan_22-1 caught doctor reporting `installed (24/24)` over exactly that arrangement — the number
 * was true and the conclusion drawn from it was false. Every consumer reads the state, so the
 * shadow has to live in the state rather than in one command's wording.
 */
function permissionStatus(settings) {
  const counts = Object.fromEntries(activeLists.map((name) => [
    name,
    matchingRules(listValue(settings, name), PERMISSION_RULES[name]),
  ]));
  const askCount = matchingRules(listValue(settings, 'ask'), [...allRules]);
  const present = counts.allow + counts.deny;
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
    return { changed: added > 0, added };
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

function statusOutput(status) {
  const moved = status.askCount
    ? `; ${status.askCount} own string(s) in ask, which outranks allow`
    : '';
  return `Permissions: ${status.state} (${status.present}/${status.total} own strings in allow/deny${moved}).`;
}

async function permissionsInRun({ host, action } = {}) {
  if (!host?.settingsPath) throw new TypeError('permissions requires a resolved host');
  if (!action) {
    const status = await inspectPermissions(host.settingsPath);
    return { exitCode: 0, output: statusOutput(status), ...status };
  }
  if (action === 'add') {
    const result = await addPermissionRules(host.settingsPath);
    // A string the operator moved into `ask` outranks the copy `add` just put into `allow`, so the
    // command would report a complete set while the questions it was run to end keep appearing.
    // `ask` stays untouched — it is a hand-made decision — but silence about it is a false success.
    const status = await inspectPermissions(host.settingsPath);
    const conflict = status.askCount
      ? ` ${status.askCount} own string(s) also sit in ask, which outranks allow; they were left there.`
      : '';
    return {
      exitCode: 0,
      output: `Added ${result.added} permission rule string${result.added === 1 ? '' : 's'}.${conflict}`,
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
