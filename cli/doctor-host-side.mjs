/**
 * Reports host marks separately from home ownership (Plan_65 D10 item 6): WHAT lies in a host
 * comes from its marks, while WHO uses the home comes only from its owner rows. A single
 * "installation: not installed" line hid a host that plainly carried our agents and hooks, and it
 * never said which hosts the home record names or whether its inventory is complete.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeRepoPath } from '../src/home/lib/runner/project-dir.mjs';
import { check } from './doctor-format.mjs';
import { hasPackageMarks } from './host-inspection.mjs';
import { isFormat2 } from './install-owners.mjs';

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
    inventoryComplete ? 'inventory complete' : 'inventory incomplete: an old record did not name every host',
    ...(unrecordedMarks
      ? [`${host.root} has package files or hooks but is not recorded: run codex-bridge install --host "${host.root}"`]
      : []),
  ];
  return check('home owners', inventoryComplete && !unrecordedMarks ? 'ok' : 'warn', parts.join('; '));
}
