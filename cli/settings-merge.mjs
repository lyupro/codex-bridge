/** Merges and removes named codex-bridge hooks without disturbing host settings. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const LEGACY_SPEC = { event: 'SubagentStop', matcher: '*' };

export function commandFor(guardPath) {
  return `node "${path.resolve(guardPath)}"`;
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
  };
}

async function readSettings(settingsPath) {
  try {
    const raw = await fs.readFile(settingsPath, 'utf8');
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('top level must be an object');
      }
      return { exists: true, raw, settings: parsed };
    } catch (err) {
      throw new Error(`cannot parse ${settingsPath}: ${err.message}`);
    }
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

export async function inspectHook(settingsPath, specOrPath) {
  const state = await readSettings(settingsPath);
  const spec = normalizeSpec(specOrPath);
  const present = groups(state.settings, spec.event)
    .filter((group) => group?.matcher === spec.matcher)
    .some((group) => groupHooks(group)
      .some((hook) => hook?.type === 'command' && hook.command === spec.command));
  return { ...state, ...spec, present };
}

function backupName(settingsPath) {
  const stamp = new Date().toISOString().replaceAll(':', '-');
  return `${settingsPath}.codex-bridge-backup-${stamp}-${randomUUID()}`;
}

async function atomicWrite(settingsPath, settings, previous) {
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  if (previous.exists) await fs.writeFile(backupName(settingsPath), previous.raw, { flag: 'wx' });
  const temporary = `${settingsPath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { flag: 'wx' });
    await fs.rename(temporary, settingsPath);
  } catch (err) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw err;
  }
}

export async function mergeHook(settingsPath, specOrPath, inspected) {
  const spec = normalizeSpec(specOrPath);
  const state = inspected || await inspectHook(settingsPath, spec);
  if (state.present) return { changed: false, createdGroup: false };
  const settings = structuredClone(state.settings);
  settings.hooks ??= {};
  if (!Array.isArray(settings.hooks[spec.event])) settings.hooks[spec.event] = [];
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
}

export async function removeHook(settingsPath, specOrPath, { createdGroup = false } = {}) {
  const spec = normalizeSpec(specOrPath);
  const state = await inspectHook(settingsPath, spec);
  if (!state.present) return { changed: false };
  const settings = structuredClone(state.settings);
  const eventGroups = groups(settings, spec.event);
  for (let index = eventGroups.length - 1; index >= 0; index -= 1) {
    const group = eventGroups[index];
    if (group?.matcher !== spec.matcher) continue;
    if (!Array.isArray(group?.hooks)) continue;
    group.hooks = group.hooks.filter((hook) =>
      !(hook?.type === 'command' && hook.command === spec.command));
    if (createdGroup && group.hooks.length === 0) eventGroups.splice(index, 1);
  }
  await atomicWrite(settingsPath, settings, state);
  return { changed: true };
}
