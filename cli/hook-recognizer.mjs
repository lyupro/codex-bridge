/**
 * Recognizes the package's own hook entries in a host's settings by their exact spelling, without
 * an installation record (Plan_65 D10 item 1).
 *
 * A format-1 record never named its host, so a host without an owner entry could only be cleaned
 * through somebody else's record. What the package wrote into a host carries its name; this module
 * reads that mark. Only exact commands count: a substring, another interpreter or an unknown file
 * is a foreign hook, and `commandForm` (settings-merge) only classifies spelling, it proves nothing.
 */
import path from 'node:path';
import { HOOK_DEFINITIONS } from './manifest.mjs';
import { normalizeRepoPath } from '../src/home/lib/runner/project-dir.mjs';

// Every directory a released version installed hook files into. Checked against git history:
// agents/codex-bridge never held hooks — they moved into the brand home (7a43fa4, 2026-08-10) a
// day before that directory existed (4eafc85).
const HOOK_DIRECTORIES = Object.freeze([
  Object.freeze({ root: 'brandRoot', segments: ['hooks'] }),
  // Before 7a43fa4 the path form pointed into host.agentsDir/hooks, and agentsDir was agents/codex.
  Object.freeze({ root: 'root', segments: ['agents', 'codex', 'hooks'] }),
]);

const DEFINITION_NAMES = new Set(HOOK_DEFINITIONS.map(({ name }) => name));
const SHORT_COMMAND = /^codex-bridge hook (\S+)$/;
const PATH_COMMAND = /^node "([^"\r\n]+)"$/;

// Windows compares file names without case, like normalizeRepoPath does for the rest of the path.
const sameFile = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

function inKnownDirectory(hookPath, host) {
  const directory = normalizeRepoPath(path.dirname(hookPath));
  return HOOK_DIRECTORIES.some(({ root, segments }) => typeof host?.[root] === 'string'
    && directory === normalizeRepoPath(path.join(host[root], ...segments)));
}

// One file can serve several hooks (dispatcher-gate.mjs is three), so a path names its hook only
// together with the event; without one, or with no match, the entry is still ours but unnamed.
function nameForFile(file, event) {
  const candidates = HOOK_DEFINITIONS.filter((definition) => sameFile(definition.file, file));
  const matching = event === undefined ? candidates : candidates.filter((definition) => definition.event === event);
  return matching.length === 1 ? matching[0].name : null;
}

export function isOwnHookCommand(command, host, event) {
  if (typeof command !== 'string') return { own: false };
  const short = SHORT_COMMAND.exec(command);
  if (short && DEFINITION_NAMES.has(short[1])) return { own: true, name: short[1], form: 'short' };
  const spelled = PATH_COMMAND.exec(command);
  if (!spelled || !path.isAbsolute(spelled[1])) return { own: false };
  const file = path.basename(spelled[1]);
  if (!HOOK_DEFINITIONS.some((definition) => sameFile(definition.file, file)) || !inKnownDirectory(spelled[1], host)) {
    return { own: false };
  }
  return { own: true, name: nameForFile(file, event), form: 'path' };
}

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Lists own hook entries across every event; unreadable settings throw, because unknown is not "none". */
export function findOwnHooks(settings, host) {
  if (!isObject(settings)) throw new TypeError('settings must be an object');
  if (!isObject(settings.hooks)) return [];
  const found = [];
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) continue;
    groups.forEach((group, groupIndex) => {
      if (!isObject(group) || !Array.isArray(group.hooks)) return;
      group.hooks.forEach((hook, hookIndex) => {
        if (hook?.type !== 'command') return;
        const recognized = isOwnHookCommand(hook.command, host, event);
        if (!recognized.own) return;
        const { name, form } = recognized;
        found.push({ event, groupIndex, hookIndex, matcher: group.matcher, command: hook.command, name, form });
      });
    });
  }
  return found;
}
