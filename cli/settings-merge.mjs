/** Merges and removes the codex-bridge SubagentStop hook without disturbing host settings. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const EVENT = 'SubagentStop';

function commandFor(guardPath) {
  return `node "${path.resolve(guardPath)}"`;
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

function groups(settings) {
  const value = settings?.hooks?.[EVENT];
  return Array.isArray(value) ? value : [];
}

function ownHook(command) {
  return { type: 'command', command, timeout: 10 };
}

function groupHooks(group) {
  return Array.isArray(group?.hooks) ? group.hooks : [];
}

export async function inspectHook(settingsPath, guardPath) {
  const state = await readSettings(settingsPath);
  const command = commandFor(guardPath);
  const present = groups(state.settings).some((group) =>
    groupHooks(group).some((hook) => hook?.type === 'command' && hook.command === command));
  return { ...state, command, present };
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

export async function mergeHook(settingsPath, guardPath, inspected) {
  const state = inspected || await inspectHook(settingsPath, guardPath);
  if (state.present) return { changed: false, createdGroup: false };
  const settings = structuredClone(state.settings);
  settings.hooks ??= {};
  if (!Array.isArray(settings.hooks[EVENT])) settings.hooks[EVENT] = [];
  let group = settings.hooks[EVENT].find((entry) => entry?.matcher === '*');
  const createdGroup = !group;
  if (!group) {
    group = { matcher: '*', hooks: [] };
    settings.hooks[EVENT].push(group);
  }
  if (!Array.isArray(group.hooks)) group.hooks = [];
  group.hooks.push(ownHook(state.command));
  await atomicWrite(settingsPath, settings, state);
  return { changed: true, createdGroup };
}

export async function removeHook(settingsPath, guardPath, { createdGroup = false } = {}) {
  const state = await inspectHook(settingsPath, guardPath);
  if (!state.present) return { changed: false };
  const settings = structuredClone(state.settings);
  const eventGroups = groups(settings);
  for (let index = eventGroups.length - 1; index >= 0; index -= 1) {
    const group = eventGroups[index];
    if (!Array.isArray(group?.hooks)) continue;
    group.hooks = group.hooks.filter((hook) =>
      !(hook?.type === 'command' && hook.command === state.command));
    if (createdGroup && group.matcher === '*' && group.hooks.length === 0) eventGroups.splice(index, 1);
  }
  await atomicWrite(settingsPath, settings, state);
  return { changed: true };
}
