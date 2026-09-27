/**
 * Keeps one installation record for a package home that several hosts share: one image part, and
 * one owner per host root (format 2, Plan_65 D5).
 *
 * The format-1 record was written whole by whichever host installed last and named no host at all:
 * `install --host A`, then `install --host B` into one home left B's record alone (reproduced
 * 2026-09-25), and uninstalling either would have removed the image under the other. Owners are
 * keyed by the lexically normalized host root, never a resolved one. An old record migrates with
 * only the migrating host as owner and the inventory marked incomplete (D6): it never recorded who
 * else used the home, and the last writer is not proof of being the only one.
 */
import { normalizeRepoPath } from '../src/home/lib/runner/project-dir.mjs';
import {
  fileEntry,
  INSTALL_METHOD_COPY,
  INSTALL_METHOD_KEY,
  validateInstallRecord,
} from './install-record.mjs';

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function isFormat2(parsed) {
  return isObject(parsed) && parsed.format === 2;
}

function filesFor(record, root) {
  return record.files.map(fileEntry).filter((file) => file.root === root)
    .map((file) => ({ root, path: file.path }));
}

function fingerprintsFor(record, root, files) {
  if (record.fingerprints === undefined) return undefined;
  const values = record.fingerprints[root]
    ?? (root === 'claude' ? record.fingerprints : undefined)
    ?? {};
  const selected = {};
  for (const file of files) {
    if (values[file.path] !== undefined) selected[file.path] = values[file.path];
  }
  return { [root]: selected };
}

function ownerFrom(record, host) {
  const files = filesFor(record, 'claude');
  const fingerprints = fingerprintsFor(record, 'claude', files);
  return {
    root: host.root,
    scope: host.scope,
    version: record.version,
    installedAt: record.installedAt,
    files,
    ...(fingerprints === undefined ? {} : { fingerprints }),
    ...(record.rules === undefined ? {} : { rules: record.rules }),
    hooks: (record.hooks ?? (record.hook === undefined ? [] : [record.hook])).map((hook) => (
      hook.root ? { ...hook } : { ...hook, root: 'claude' }
    )),
  };
}

function imageFrom(record) {
  const files = filesFor(record, 'brand');
  const fingerprints = fingerprintsFor(record, 'brand', files);
  return {
    version: record.version,
    installedAt: record.installedAt,
    files,
    ...(fingerprints === undefined ? {} : { fingerprints }),
  };
}

function mergeFingerprints(image, owner) {
  if (image.fingerprints === undefined && owner.fingerprints === undefined) return undefined;
  return { ...(image.fingerprints ?? {}), ...(owner.fingerprints ?? {}) };
}

export function ownerView(record2, host) {
  if (!isFormat2(record2)) return null;
  const key = normalizeRepoPath(host.root);
  const owner = record2.owners?.[key];
  if (!owner) return null;
  const view = {
    name: record2.name,
    [INSTALL_METHOD_KEY]: record2[INSTALL_METHOD_KEY],
    version: owner.version,
    installedAt: owner.installedAt,
    files: [...record2.image.files, ...owner.files],
    hooks: owner.hooks,
  };
  const fingerprints = mergeFingerprints(record2.image, owner);
  if (fingerprints !== undefined) view.fingerprints = fingerprints;
  if (owner.rules !== undefined) view.rules = owner.rules;
  return view;
}

/** Removes one host from the shared inventory while preserving its image and inventory facts. */
export function withoutOwner(record2, host) {
  validateFormat2(record2);
  const key = normalizeRepoPath(host.root);
  if (!Object.hasOwn(record2.owners, key)) return record2;
  const owners = { ...record2.owners };
  delete owners[key];
  return validateFormat2({ ...record2, owners });
}

export function withOwner(existing, host, record1, options) {
  validateInstallRecord(record1);
  const key = normalizeRepoPath(host.root);
  const image = imageFrom(record1);
  const owner = ownerFrom(record1, host);

  if (existing === null) {
    // Only an explicit false proves no earlier installation used this home; unknown is incomplete.
    const confirmedNoPriorImage = options?.homeHadImage === false;
    const created = {
      format: 2,
      name: record1.name,
      [INSTALL_METHOD_KEY]: record1[INSTALL_METHOD_KEY],
      image,
      inventory: confirmedNoPriorImage ? 'complete' : 'incomplete',
      owners: { [key]: owner },
    };
    return validateFormat2(created);
  }

  let previous;
  if (isFormat2(existing)) {
    previous = validateFormat2(existing);
  } else {
    if (Object.hasOwn(existing ?? {}, 'format')) {
      throw new Error(`unknown installation record format: ${existing.format}`);
    }
    validateInstallRecord(existing);
    previous = {
      format: 2,
      name: record1.name,
      [INSTALL_METHOD_KEY]: record1[INSTALL_METHOD_KEY],
      image,
      inventory: 'incomplete',
      owners: {},
      legacy: existing,
    };
  }

  const next = {
    ...previous,
    name: record1.name,
    [INSTALL_METHOD_KEY]: record1[INSTALL_METHOD_KEY],
    image,
    owners: { ...previous.owners, [key]: owner },
  };
  return validateFormat2(next);
}

function validatePartition(part, root, label) {
  if (!isObject(part)) throw new Error(`installation record ${label} must be an object`);
  if (!Array.isArray(part.files)) throw new Error(`installation record ${label} files must be a list`);
  if (part.files.some((file) => fileEntry(file)?.root !== root)) {
    throw new Error(`installation record ${label} files must use the ${root} root`);
  }
  if (part.fingerprints !== undefined) {
    if (!isObject(part.fingerprints)
      || Object.keys(part.fingerprints).some((key) => key !== root)) {
      throw new Error(`installation record ${label} fingerprints must use the ${root} root`);
    }
  }
}

export function validateFormat2(parsed) {
  if (!isObject(parsed) || parsed.format !== 2) {
    throw new Error('installation record format must be 2');
  }
  if (parsed.inventory !== 'complete' && parsed.inventory !== 'incomplete') {
    throw new Error('installation record inventory must be complete or incomplete');
  }
  if (!isObject(parsed.owners)) throw new Error('installation record owners must be an object');
  if (Object.keys(parsed.owners).length === 0 && parsed.inventory !== 'incomplete') {
    throw new Error('installation record with no owners must have an incomplete inventory');
  }
  validatePartition(parsed.image, 'brand', 'image');

  for (const [key, owner] of Object.entries(parsed.owners)) {
    if (!isObject(owner) || typeof owner.root !== 'string' || !owner.root) {
      throw new Error(`installation record owner ${key} must have a root`);
    }
    if (normalizeRepoPath(owner.root) !== key) {
      throw new Error(`installation record owner root must normalize to its key: ${key}`);
    }
    if (typeof owner.scope !== 'string' || !owner.scope) {
      throw new Error(`installation record owner ${key} has invalid scope`);
    }
    validatePartition(owner, 'claude', `owner ${key}`);
    const view = ownerView(parsed, { root: owner.root });
    validateInstallRecord(view);
    validateInstallRecord({ ...view, version: parsed.image.version, installedAt: parsed.image.installedAt });
  }

  if (typeof parsed.name !== 'string' || !parsed.name) throw new Error('installation record has invalid name');
  if (parsed.legacy !== undefined) validateInstallRecord(parsed.legacy);
  if (parsed[INSTALL_METHOD_KEY] !== INSTALL_METHOD_COPY) {
    throw new Error(`installation record ${INSTALL_METHOD_KEY} must be ${INSTALL_METHOD_COPY}`);
  }
  return parsed;
}
