/**
 * Decides and performs what happens to the Codex rules file when a host leaves the package.
 * Plan_65 B20a: uninstall and purge detach hosts alike, so sharing rules ownership and fingerprint
 * decisions prevents their behavior and output from drifting apart.
 */
import { fileFingerprint } from './manifest.mjs';
import { removeRulesOwner, remainingRulesOwners } from './rules-owners.mjs';
import { removeOutside } from './record-removal.mjs';

export function remainingOwnersText(count) {
  return `${count} other owner${count === 1 ? '' : 's'} ${count === 1 ? 'remains' : 'remain'}`;
}

export async function rulesDryRunLines({ host, record, registry, registryError, detached }) {
  const lines = [];
  if (!record?.rules || !detached) return lines;
  if (registryError) {
    lines.push(`Would leave ${record.rules.path} because the rules ownership registry is invalid; \
ownership is unknown.`);
  } else {
    const remainingOwners = remainingRulesOwners(registry, host);
    const currentFingerprint = await fileFingerprint(record.rules.path);
    if (remainingOwners?.length) {
      lines.push(`Would leave ${record.rules.path} because ${remainingOwnersText(remainingOwners.length)}.`);
    } else if (currentFingerprint === record.rules.fingerprint) {
      lines.push(`Would remove ${record.rules.path}; no other owners remain and its fingerprint is unchanged.`);
    } else if (currentFingerprint !== null) {
      lines.push(`Would leave ${record.rules.path} because its contents changed after installation.`);
    } else {
      lines.push(`Would leave ${record.rules.path} because it is already absent.`);
    }
    if (!registry) {
      lines.push(`Warning: the rules ownership registry was missing; \
other installations may use ${record.rules.path}.`);
    }
  }
  return lines;
}

export async function removeRulesForHost({ host, record, registry, registryError, detached, writer }) {
  const detachedRecord = record && detached ? record : null;
  let ownership = null;
  if (detachedRecord && !registryError) {
    try {
      ownership = await removeRulesOwner(host);
    } catch (err) {
      registryError = err;
    }
  }
  const lines = [];
  if (detachedRecord?.rules) {
    if (registryError) {
      lines.push(`Left ${record.rules.path} because the rules ownership registry is invalid; ownership is unknown.`);
    } else {
      if (ownership?.owners.length) {
        lines.push(`Left ${record.rules.path} because ${remainingOwnersText(ownership.owners.length)}.`);
      } else {
        const currentFingerprint = await fileFingerprint(record.rules.path);
        if (currentFingerprint === record.rules.fingerprint) {
          await removeOutside(writer, record.rules.path);
        } else if (currentFingerprint !== null) {
          lines.push(`Left ${record.rules.path} because its contents changed after installation.`);
        }
      }
      if (!registry) {
        lines.push(`Warning: the rules ownership registry was missing; \
other installations may use ${record.rules.path}.`);
      }
    }
  }
  return { lines, registryError };
}
