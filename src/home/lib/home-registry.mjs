/**
 * Declares every file the package may write into its home, each with the removal class it belongs to.
 *
 * `uninstall` removed only what the installation record listed, and until 0.6.7 said nothing about
 * the rest: `state/` fell out of its message, and every next file a feature added would have too
 * (Plan_62 D22). A registry the writers must name makes an undeclared file unwritable instead of
 * forgotten. Side files (locks, temporaries) are spelled here and nowhere else, because a purge that
 * knows the target but not its `.lock` leaves the lock behind. Image members are supplied by the
 * caller: the home image ships without `cli/`, so this module cannot read the manifest itself.
 */
import path from 'node:path';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

// Plan_62 D22 requires side files to be as explicit as their owning artifacts.
const SIDE_SPELLINGS = Object.freeze({
  lock: /^(.+)\.lock$/,
  'atomic-temporary': new RegExp(`^(.+)\\.${UUID}\\.tmp$`),
  'dot-temporary': new RegExp(`^\\.(.+)\\.${UUID}\\.tmp$`),
  'copy-temporary': new RegExp(`^\\.(.+)\\.${UUID}\\.tmp$`),
  'pid-temporary': new RegExp(`^(.+)\\.[0-9]+\\.${UUID}\\.tmp$`),
});

const entries = [
  {
    id: 'install-image',
    removal: 'install-owned',
    consequence: "The package's code and guards; reinstall restores them.",
    primary: [],
    sides: ['copy-temporary'],
  },
  {
    id: 'install-record',
    removal: 'install-owned',
    consequence: 'The installation record is lost and uninstall can no longer identify installed files.',
    primary: ['.installed.json'],
    sides: [],
  },
  {
    id: 'config',
    removal: 'purge-only',
    consequence: "The operator's model and retention settings are lost.",
    primary: ['config.json'],
    sides: ['lock', 'dot-temporary'],
  },
  {
    id: 'conventions',
    removal: 'purge-only',
    consequence: "The operator's edited conventions are lost.",
    primary: ['conventions.md'],
    // Plan_65 B9: install seeds it through the planned-file copier, which publishes via a temporary.
    sides: ['copy-temporary'],
  },
  {
    id: 'host-contract',
    removal: 'purge-only',
    consequence: 'Refusal measurements are lost and collecting them again costs a paid probe of about two minutes of Claude quota.',
    primary: ['.host-contract.json'],
    sides: ['pid-temporary'],
  },
  {
    id: 'dispatcher-contract',
    removal: 'purge-only',
    consequence: 'Dispatcher contract measurements are lost and collecting them again costs a paid probe of about two minutes of Claude quota.',
    primary: ['state/dispatcher-contract.json'],
    sides: ['atomic-temporary'],
  },
  {
    id: 'dispatcher-state',
    removal: 'purge-only',
    consequence: 'A dispatcher still running loses the runner output its handback is replaced with.',
    primary: {
      dir: 'state/dispatchers',
      pattern: /^[0-9a-f]{32}\.json$/,
    },
    sides: ['lock', 'atomic-temporary'],
  },
  {
    id: 'handback-witness',
    removal: 'purge-only',
    consequence: 'Doctor forgets on which host a handback was last seen and every alarm it recorded.',
    primary: ['state/handback-witness.json'],
    sides: ['lock', 'atomic-temporary'],
  },
  {
    id: 'host-observations',
    removal: 'purge-only',
    consequence: 'Doctor forgets which host versions sessions ran on until the next shell command in a session.',
    primary: ['state/host-observations.json'],
    sides: ['lock', 'atomic-temporary'],
  },
  {
    id: 'guard-tries',
    removal: 'purge-only',
    consequence: 'Guard budgets start over.',
    primary: ['state/reply-guard-tries.json'],
    sides: [],
  },
  {
    id: 'diagnostics',
    removal: 'purge-only',
    consequence: 'This artifact holds the full hook input of the last call.',
    primary: ['state/diagnostics/order-gate.last.json', 'state/diagnostics/reply-guard.last.json'],
    sides: [],
  },
];

export const HOME_ARTIFACTS = Object.freeze(entries.map((entry) => Object.freeze({
  ...entry,
  primary: Array.isArray(entry.primary)
    ? Object.freeze([...entry.primary])
    : Object.freeze({
      dir: entry.primary.dir,
      pattern: Object.freeze(new RegExp(entry.primary.pattern.source, entry.primary.pattern.flags)),
    }),
  sides: Object.freeze([...entry.sides]),
})));

export const HOME_DIRECTORIES = Object.freeze([
  'state',
  'state/dispatchers',
  'state/diagnostics',
]);

const artifactsById = new Map(HOME_ARTIFACTS.map((entry) => [entry.id, entry]));

function validRelativePath(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) return false;
  if (relativePath.includes('\\') || path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    return false;
  }
  return !relativePath.split('/').some((segment) => (
    segment.length === 0 || segment === '.' || segment === '..'
  ));
}

function imagePathSet(imageMembers) {
  const paths = new Set();
  for (const relativePath of imageMembers ?? []) {
    if (validRelativePath(relativePath)) paths.add(relativePath);
  }
  return paths;
}

function primaryMatches(entry, relativePath) {
  if (Array.isArray(entry.primary)) return entry.primary.includes(relativePath);
  const slash = relativePath.lastIndexOf('/');
  const dir = slash < 0 ? '' : relativePath.slice(0, slash);
  const name = slash < 0 ? relativePath : relativePath.slice(slash + 1);
  return dir === entry.primary.dir && entry.primary.pattern.test(name);
}

function sideMatches(entry, relativePath) {
  const slash = relativePath.lastIndexOf('/');
  const dir = slash < 0 ? '' : relativePath.slice(0, slash);
  const name = slash < 0 ? relativePath : relativePath.slice(slash + 1);
  for (const side of entry.sides) {
    const match = SIDE_SPELLINGS[side].exec(name);
    if (!match) continue;
    const primaryName = match[1];
    const primaryPath = dir ? `${dir}/${primaryName}` : primaryName;
    if (primaryMatches(entry, primaryPath)) return side;
  }
  return null;
}

export function classifyHomePath(relativePath, { imageMembers } = {}) {
  if (!validRelativePath(relativePath)) return null;
  const images = imagePathSet(imageMembers);

  for (const entry of HOME_ARTIFACTS) {
    if (entry.id === 'install-image') continue;
    if (primaryMatches(entry, relativePath)) return { id: entry.id, role: 'primary' };
  }
  for (const entry of HOME_ARTIFACTS) {
    if (entry.id === 'install-image') continue;
    const role = sideMatches(entry, relativePath);
    if (role) return { id: entry.id, role };
  }

  if (images.has(relativePath)) return { id: 'install-image', role: 'primary' };
  const imageArtifact = artifactsById.get('install-image');
  const role = sideMatches({ ...imageArtifact, primary: [...images] }, relativePath);
  return role ? { id: 'install-image', role } : null;
}

export function homeArtifact(id) {
  const entry = artifactsById.get(id);
  if (!entry) throw new Error(`Unknown home artifact id: ${id}`);
  return entry;
}
