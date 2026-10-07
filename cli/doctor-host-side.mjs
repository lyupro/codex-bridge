/**
 * Reports host marks separately from home ownership (Plan_65 D10 item 6): WHAT lies in a host
 * comes from its marks, while WHO uses the home comes only from its owner rows. A single
 * "installation: not installed" line hid a host that plainly carried our agents and hooks, and it
 * never said which hosts the home record names or whether its inventory is complete.
 * Owners in sync keeps lagging hosts visible because install/update named them only once (Plan_65 D11 item 3).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeRepoPath } from '../src/home/lib/runner/project-dir.mjs';
import { check } from './doctor-format.mjs';
import { hasPackageMarks } from './host-inspection.mjs';
import { isFormat2 } from '../src/home/lib/install-owner-roots.mjs';
import { imageFingerprint } from './install-owners.mjs';
import { INVENTORY_CONFIRM_COMMAND } from './inventory-confirm.mjs';

const inventoryRepair = `; run ${INVENTORY_CONFIRM_COMMAND} if the recorded hosts are all of them`;

const ownerRepair = '; install into each host first: run codex-bridge install --host "<path>"';

// Format 1 is not migrated here: asFormat2 would record this host as the owner, and doctor only reads.
export function ownerEntry(rawRecord, host) {
  if (rawRecord === null || !isFormat2(rawRecord)) return null;
  return rawRecord.owners[normalizeRepoPath(host.root)] ?? null;
}

export function hostSideCheck(host, inspection) {
  if (inspection.settingsError) {
    return check('host files', 'fail', `settings could not be read: ${inspection.settingsError}`);
  }
  if (!hasPackageMarks(inspection)) {
    return check('host files', 'warn', `no codex-bridge files or hooks in ${host.root}`);
  }

  const kept = inspection.files.filter((file) => file.disposition === 'keep'
    && ['changed', 'unknown'].includes(file.reason));
  const counts = `${inspection.files.length} package file(s) and ${inspection.hooks.length} own hook(s) in ${host.root}`;
  const keptText = kept.map((file) => `${file.relativeToHost} (${file.reason})`).join(', ');
  return kept.length
    ? check('host files', 'warn', `${counts}; kept by uninstall: ${keptText}`)
    : check('host files', 'ok', counts);
}

async function homeImageExists(host) {
  try {
    await fs.access(path.join(host.brandRoot, 'lib'));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function homeOwnersCheck(host, rawRecord, inspection) {
  if (rawRecord === null) {
    return await homeImageExists(host)
      ? check('home owners', 'warn', `no installation record in ${host.brandRoot}; the image has no record`)
      : check('home owners', 'ok', `no installation record in ${host.brandRoot}`);
  }
  if (!isFormat2(rawRecord)) {
    return check(
      'home owners',
      'warn',
      'old record format; the hosts using this home are unknown until the next install or update',
    );
  }

  const roots = Object.values(rawRecord.owners).map((owner) => owner.root);
  const inventoryComplete = rawRecord.inventory === 'complete' && rawRecord.legacy === undefined;
  const hostRecorded = Object.hasOwn(rawRecord.owners, normalizeRepoPath(host.root));
  const unrecordedMarks = hasPackageMarks(inspection) && !hostRecorded;
  const parts = [
    `recorded: ${roots.length ? roots.join(', ') : 'none'}`,
    inventoryComplete ? 'inventory complete'
      : `inventory incomplete: an old record did not name every host${roots.length ? inventoryRepair : ownerRepair}`,
    ...(unrecordedMarks
      ? [`${host.root} has package files or hooks but is not recorded: run codex-bridge install --host "${host.root}"`]
      : []),
  ];
  return check('home owners', inventoryComplete && !unrecordedMarks ? 'ok' : 'warn', parts.join('; '));
}

export function ownersInSyncCheck(rawRecord) {
  if (rawRecord === null || !isFormat2(rawRecord)) {
    return check('owners in sync', 'ok', 'no format-2 record; nothing to compare');
  }

  const owners = Object.values(rawRecord.owners);
  const inventoryComplete = rawRecord.inventory === 'complete' && rawRecord.legacy === undefined;
  if (!owners.length) {
    return check('owners in sync', 'warn',
      `no recorded owners${inventoryComplete ? '' : `; inventory incomplete${ownerRepair}`}`);
  }

  const fingerprint = imageFingerprint(rawRecord.image);
  const parts = [];
  const unstamped = [];
  for (const owner of owners) {
    if (owner.imageFingerprint != null) {
      if (owner.imageFingerprint === fingerprint) continue;
    } else if (owner.version === rawRecord.image.version) {
      unstamped.push(owner.root);
      continue;
    }
    // The same version on both sides is the clone case the stamp exists for; say so instead of "0.6.9, image 0.6.9".
    const why = owner.version === rawRecord.image.version
      ? `verified against an earlier image of ${owner.version}`
      : `recorded ${owner.version}, image ${rawRecord.image.version}`;
    parts.push(`${owner.root} (${why}): run codex-bridge update --host "${owner.root}"`);
  }
  if (unstamped.length) parts.push(`not yet verified by image fingerprint: ${unstamped.join(', ')}`);
  if (!inventoryComplete) parts.push(`inventory incomplete${inventoryRepair}`);
  const warning = parts.length > 0;
  if (!warning) parts.push(`all ${owners.length} owner(s) verified against the current image`);
  return check('owners in sync', warning ? 'warn' : 'ok',
    `${parts.join('; ')} (recorded verification; host files and reachability not inspected)`);
}
