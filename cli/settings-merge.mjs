/** Merges and removes named codex-bridge hooks without disturbing host settings. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJsonFileWithRaw } from '../src/home/lib/json-file.mjs';

const LEGACY_SPEC = { event: 'SubagentStop', matcher: '*' };
const settingsRuns = new AsyncLocalStorage();

export function commandFor(guardPath) {
  return `node "${path.resolve(guardPath)}"`;
}

export function shortCommandFor(name) {
  return `codex-bridge hook ${name}`;
}

function envValue(env, name) {
  const key = Object.keys(env).find((entry) => entry.toLowerCase() === name);
  return key ? env[key] : '';
}

function pathValue(env) {
  return envValue(env, 'path');
}

function resolveCommand(name, env) {
  const extensions = process.platform === 'win32'
    ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')
    : [''];
  for (const directory of pathValue(env).split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(path.resolve(directory), `${name}${extension}`);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      } catch {
        continue;
      }
    }
  }
  return null;
}

export function commandReachable(name = 'codex-bridge', env = process.env) {
  return Boolean(resolveCommand(name, env));
}

/**
 * The version the command on PATH reports, or null when there is none or it will not say.
 *
 * Existence used to be the only question, and on 2026-08-11 that cost the operator every guard on
 * the machine: an install from the clone wrote `codex-bridge hook <name>` while the command on
 * PATH was the previous release, which has no `hook` subcommand. Every guard then failed before it
 * could decide anything, and the host refused Bash, PowerShell, file edits and agent launches.
 */
export function reachableCommandVersion(name = 'codex-bridge', env = process.env) {
  const result = runReachableCommand(name, ['--version'], env);
  if (!result || result.status !== 0) return null;
  return String(result.stdout || '').trim().split(/\r?\n/).pop()?.trim() || null;
}

export function runReachableCommand(name, args, env = process.env) {
  const shimPath = resolveCommand(name, env);
  if (!shimPath) return null;
  // Node 24 warned with DEP0190 during update (2026-09-07): invoke cmd explicitly for npm shims.
  // Live probes covered plain, bin with space, Program Files (x86), weird & name, and caret^dir.
  // /d /s /c with path and fixed arguments as separate arguments only passed the plain directory:
  // Node adds quotes, then cmd's /s strips the first and last quote of the whole command line.
  // /d /c without /s failed on & and ^. This single, double-wrapped verbatim command passed all
  // five. Keep native path separators: forward-slash Windows paths do not work through cmd.
  // The interpreter is a property of the machine, not of the PATH handed in: resolving cmd.exe
  // through the caller's PATH would return null on any env whose PATH omits System32, hiding the
  // exact command outcome this probe exists to report.
  const shell = envValue(env, 'comspec') || process.env.ComSpec || 'cmd.exe';
  const fixedArgs = args.map((argument) => ` ${argument}`).join('');
  const result = process.platform === 'win32'
    ? spawnSync(shell, ['/d', '/s', '/c', `""${shimPath}"${fixedArgs}"`], {
      encoding: 'utf8', env, shell: false, windowsVerbatimArguments: true, windowsHide: true,
      timeout: 10000, maxBuffer: 64 * 1024,
    })
    : spawnSync(shimPath, args, {
      encoding: 'utf8', env, shell: false, windowsHide: true, timeout: 10000, maxBuffer: 64 * 1024,
    });
  return { path: shimPath, status: result.status, stdout: String(result.stdout || '') };
}

export function hookRegistration(name, target, probe) {
  if (probe.ok) {
    return {
      command: shortCommandFor(name),
      form: 'short',
      reason: `codex-bridge on PATH launches guards from this home (${probe.homeRoot})`,
    };
  }
  return { command: commandFor(target), form: 'path', reason: `${probe.reason}; the installed copy will execute` };
}

export function commandForm(command) {
  return command.startsWith('codex-bridge hook ') ? 'short' : 'path';
}

function normalizeSpec(specOrPath) {
  if (typeof specOrPath === 'string') {
    return { ...LEGACY_SPEC, command: commandFor(specOrPath) };
  }
  if (!specOrPath || typeof specOrPath !== 'object'
    || typeof specOrPath.event !== 'string'
    || typeof specOrPath.matcher !== 'string'
    || typeof specOrPath.command !== 'string') {
    throw new TypeError('hook spec must contain event, matcher, and command strings');
  }
  return {
    event: specOrPath.event,
    matcher: specOrPath.matcher,
    command: specOrPath.command,
    alternateCommands: Array.isArray(specOrPath.alternateCommands)
      ? specOrPath.alternateCommands.filter((command) => typeof command === 'string')
      : [],
  };
}

export async function readSettings(settingsPath) {
  try {
    const { raw, value: settings } = await readJsonFileWithRaw(settingsPath);
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new Error(`cannot parse ${settingsPath}: top level must be an object`);
    }
    return { exists: true, raw, settings };
  } catch (err) {
    if (err.code === 'ENOENT') return { exists: false, raw: null, settings: {} };
    throw err;
  }
}

function groups(settings, event) {
  const value = settings?.hooks?.[event];
  return Array.isArray(value) ? value : [];
}

function ownHook(command) {
  return { type: 'command', command, timeout: 10 };
}

function groupHooks(group) {
  return Array.isArray(group?.hooks) ? group.hooks : [];
}

const hasOwnCommand = (group, commands) => {
  const expected = Array.isArray(commands) ? commands : [commands];
  return groupHooks(group).some((hook) => hook?.type === 'command' && expected.includes(hook.command));
};

/**
 * Presence is decided by the command, not by the matcher it currently sits under; writing then
 * places that command under the matcher the package declares. These are two halves of one rule.
 *
 * The matcher is generated from the tool list in hook-definitions.mjs, so it changes whenever a
 * host spelling is added — `Agent` became `Agent|Task` in one release, and the write-tool matcher
 * will grow the same way. A host installed under the old matcher would then be invisible to the
 * new lookup: update would register a duplicate and uninstall would leave a hook pointing at a
 * deleted file. Conversely, the 2026-08-17 host proved that finding alone is insufficient: its
 * worktree lock stayed under the pre-shell matcher, so Bash never reached the guard. The command
 * is this package's own absolute path, so it identifies our entry wherever the group ended up,
 * and merge can move it without creating a duplicate. Alternate commands identify our entry, but
 * do not prove it is in the launcher form selected for this operation. Update must rewrite stale
 * forms, or unsafe registrations already in settings.json would survive every future update.
 */
export async function inspectHook(settingsPath, specOrPath) {
  const state = await readSettings(settingsPath);
  const spec = normalizeSpec(specOrPath);
  const commands = [spec.command, ...spec.alternateCommands];
  let matchedCommand;
  let matchedMatcher;
  let requiresMove = false;
  let requiresRewrite = false;
  let duplicates = 0;
  for (const group of groups(state.settings, spec.event)) {
    for (const hook of groupHooks(group)) {
      if (hook?.type !== 'command' || !commands.includes(hook.command)) continue;
      matchedCommand ??= hook.command;
      matchedMatcher ??= group?.matcher;
      duplicates += 1;
      if (hook.command !== spec.command) requiresRewrite = true;
      if (group?.matcher !== spec.matcher) requiresMove = true;
    }
  }
  return {
    ...state,
    ...spec,
    present: Boolean(matchedCommand),
    matchedCommand,
    matchedMatcher,
    requiresMove,
    requiresRewrite,
    duplicates: duplicates > 1,
    current: Boolean(matchedCommand) && !requiresMove && !requiresRewrite && duplicates === 1,
  };
}

function backupName(settingsPath) {
  const stamp = new Date().toISOString().replaceAll(':', '-');
  return `${settingsPath}.codex-bridge-backup-${stamp}-${randomUUID()}`;
}

function runKey(settingsPath) {
  return path.resolve(settingsPath);
}

/**
 * A command gets one in-memory backup scope. AsyncLocalStorage keeps concurrent commands separate
 * in one process, while nested install calls reuse their caller's scope (Plan_24).
 */
export async function withSettingsRun(settingsPath, action) {
  if (typeof action !== 'function') throw new TypeError('settings run action must be a function');
  const key = runKey(settingsPath);
  const active = settingsRuns.getStore();
  if (active?.key === key) return action();
  return settingsRuns.run({ key, backupTaken: false }, action);
}

function withMutationRun(settingsPath, action) {
  const active = settingsRuns.getStore();
  return active?.key === runKey(settingsPath)
    ? action()
    : withSettingsRun(settingsPath, action);
}

async function atomicWrite(settingsPath, settings, previous) {
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  const active = settingsRuns.getStore();
  const ownsScope = active?.key === runKey(settingsPath);
  const shouldBackup = !ownsScope || !active.backupTaken;
  if (ownsScope) active.backupTaken = true;
  if (shouldBackup && previous.exists) {
    await fs.writeFile(backupName(settingsPath), previous.raw, { flag: 'wx' });
  }
  const temporary = `${settingsPath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { flag: 'wx' });
    await fs.rename(temporary, settingsPath);
  } catch (err) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Runs a settings mutation through the hook writer's backup and atomic-write boundary.
 * Plan_22 requires permissions to preserve the same recovery guarantee after the settings merge
 * incident: a second writer must not grow its own backup or serialization path.
 */
export async function updateSettings(settingsPath, edit) {
  if (typeof edit !== 'function') throw new TypeError('settings edit must be a function');
  return withMutationRun(settingsPath, async () => {
    const previous = await readSettings(settingsPath);
    const settings = structuredClone(previous.settings);
    const result = await edit(settings);
    if (!result?.changed) return result || { changed: false };
    await atomicWrite(settingsPath, settings, previous);
    return result;
  });
}

export async function mergeHook(settingsPath, specOrPath, inspected) {
  return withMutationRun(settingsPath, async () => {
    const spec = normalizeSpec(specOrPath);
    const state = inspected || await inspectHook(settingsPath, spec);
    if (state.current) return { changed: false, createdGroup: false };
    const settings = structuredClone(state.settings);
    settings.hooks ??= {};
    if (!Array.isArray(settings.hooks[spec.event])) settings.hooks[spec.event] = [];
    if (state.present) {
      const eventGroups = settings.hooks[spec.event];
      const commands = [spec.command, ...spec.alternateCommands];
      // The entry in the declared group wins, so a field the operator added there (a timeout)
      // survives the rewrite; groups are walked from the end, which would otherwise pick a stale copy.
      let hookToMove;
      let declaredHook;
      for (let index = eventGroups.length - 1; index >= 0; index -= 1) {
        const group = eventGroups[index];
        if (!Array.isArray(group?.hooks)) continue;
        const hadOwnHook = hasOwnCommand(group, commands);
        group.hooks = group.hooks.filter((hook) => {
          if (hook?.type !== 'command' || !commands.includes(hook.command)) return true;
          hookToMove ??= hook;
          if (group.matcher === spec.matcher) declaredHook ??= hook;
          return false;
        });
        if (hadOwnHook && group.hooks.length === 0) eventGroups.splice(index, 1);
      }
      let group = eventGroups.find((entry) => entry?.matcher === spec.matcher);
      const createdGroup = !group;
      if (!group) {
        group = { matcher: spec.matcher, hooks: [] };
        eventGroups.push(group);
      }
      if (!Array.isArray(group.hooks)) group.hooks = [];
      group.hooks.push({ ...(declaredHook || hookToMove), command: spec.command });
      await atomicWrite(settingsPath, settings, state);
      return { changed: true, createdGroup, ...(state.requiresMove ? { moved: true } : {}), ...(state.requiresRewrite ? { rewritten: true } : {}) };
    }
    let group = settings.hooks[spec.event].find((entry) => entry?.matcher === spec.matcher);
    const createdGroup = !group;
    if (!group) {
      group = { matcher: spec.matcher, hooks: [] };
      settings.hooks[spec.event].push(group);
    }
    if (!Array.isArray(group.hooks)) group.hooks = [];
    group.hooks.push(ownHook(spec.command));
    await atomicWrite(settingsPath, settings, state);
    return { changed: true, createdGroup };
  });
}

export async function removeHook(settingsPath, specOrPath, { createdGroup = false } = {}) {
  return withMutationRun(settingsPath, async () => {
    const spec = normalizeSpec(specOrPath);
    const state = await inspectHook(settingsPath, spec);
    if (!state.present) return { changed: false };
    const settings = structuredClone(state.settings);
    const eventGroups = groups(settings, spec.event);
    // Removal follows the same rule as the lookup above: our command, whatever matcher it is
    // filed under. A foreign hook is left alone because its command is not ours, not because it
    // sits in another group.
    for (let index = eventGroups.length - 1; index >= 0; index -= 1) {
      const group = eventGroups[index];
      const commands = [spec.command, ...spec.alternateCommands];
      if (!hasOwnCommand(group, commands)) continue;
      if (!Array.isArray(group?.hooks)) continue;
      group.hooks = group.hooks.filter((hook) =>
        !(hook?.type === 'command' && commands.includes(hook.command)));
      if (createdGroup && group.hooks.length === 0) eventGroups.splice(index, 1);
    }
    await atomicWrite(settingsPath, settings, state);
    return { changed: true };
  });
}
