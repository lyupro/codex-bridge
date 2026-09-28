/**
 * Uninstalls one host: its side from an inspection of the package's marks, the shared image only from
 * the record and only once the host is detached, preserving host data and foreign files (Plan_65 D10).
 */
import path from 'node:path';
import {
  fileFingerprint,
  installRecordPath,
  legacyInstallRecordPath,
  readInstallRecord,
} from './manifest.mjs';
import { imageRemoval } from './install-owners.mjs';
import { asFormat2, readInstallRecordFile, removeInstallOwner } from './install-record.mjs';
import { normalizeRepoPath } from '../src/home/lib/runner/project-dir.mjs';
import { removePermissionRules } from './permissions.mjs';
import { hostContractPath } from './host-contract.mjs';
import { inspectHost, hasPackageMarks } from './host-inspection.mjs';
import { removeHostSide } from './host-removal.mjs';
import { askRemoval, removalHint } from './inventory-removal.mjs';
import { brandStateDir } from '../src/home/lib/brand-home.mjs';
import { withSettingsRun } from './settings-merge.mjs';
import { withLifecycle } from './lifecycle-transaction.mjs';
import { readRulesRegistry, removeRulesOwner, remainingRulesOwners } from './rules-owners.mjs';
import { removeEmpty, removeEmptyLayout } from './remove-layout.mjs';
import { recordHomeWriter, removeOutside, removeRecordedFile } from './record-removal.mjs';

function remainingOwnersText(count) {
  return `${count} other owner${count === 1 ? '' : 's'} ${count === 1 ? 'remains' : 'remain'}`;
}

function permissionOutput(host, removed, dryRun) {
  const verb = dryRun ? 'Would remove' : 'Removed';
  const plural = removed === 1 ? 'string' : 'strings';
  return `${verb} ${removed} permission rule ${plural} from ${host.settingsPath}.`;
}

// Plan_62 D22: uninstall removes only recorded files, and the message used to name only runs and
// config.json — state/, the host measurement and conventions.md stayed behind unmentioned. Until
// Plan_65 derives this from a registry, the sentence names every kind the package writes while working.
function preservationText(host) {
  return `Run artifacts in ${path.join(host.root, 'codex-runs')} are preserved, and so is what the package `
    + `wrote into ${host.brandRoot} while working: the run configuration ${host.brandConfigPath}, the conventions `
    + `${host.brandConventionsPath}, the host measurement ${hostContractPath(host)} and runtime state in `
    + `${brandStateDir(host.brandRoot)} (dispatcher state, guard counters, the handback witness, the host `
    + 'observations, dispatcher contract verdicts, and hook diagnostics that hold the full hook input). Delete them by '
    + 'hand for a complete removal.';
}

function displayFile(file) {
  return `${file.root}/${file.path}`;
}

// Plan_65 D6: uninstalling one host removed the shared image from under every other host of the
// home. Only a record at the old per-host path (no home record at all) keeps the old behavior.
function imageDecision(rawRecord, host) {
  if (rawRecord === null) return { removeImage: true };
  return imageRemoval(asFormat2(rawRecord, host), host);
}

function imageDispositionLine(host, decision, dryRun) {
  if (decision.removeImage) return null;
  const verb = dryRun ? 'Would leave' : 'Left';
  if (decision.reason === 'no-record') {
    return `${verb} the shared image in ${host.brandRoot} because this host has no installation record; its members are unknown.`;
  }
  if (decision.reason === 'other-owners') {
    return `${verb} the shared image in ${host.brandRoot} because ${remainingOwnersText(decision.remaining)}.`;
  }
  return `${verb} the shared image in ${host.brandRoot} because the installation inventory is incomplete: other installations may use this home.`;
}

async function uninstallInRun(options = {}) {
  const { host, dryRun = false } = options;
  // Preflight before removing the hook: package removal on a broken registry left the host without its watchdog.
  let registry = null;
  let registryError = null;
  try {
    registry = await readRulesRegistry(host);
  } catch (err) {
    registryError = err;
  }
  // Plan_65 D9: the question precedes the first change, so the record is read before the permission rules go;
  // a cancel then leaves the host exactly as it was.
  const rawRecord = await readInstallRecordFile(host);
  const record = await readInstallRecord(host);
  const ownerKey = normalizeRepoPath(host.root);
  const format2 = rawRecord === null ? null : asFormat2(rawRecord, host);
  const owner = format2?.owners[ownerKey] ?? null;
  // Plan_65 D10: inspect marks and content before permission edits or any other host mutation.
  const inspection = await inspectHost(host, { owner });
  let decision = rawRecord === null
    ? (record ? { removeImage: true } : { removeImage: false, reason: 'no-record' })
    : imageDecision(rawRecord, host);
  if (!record && decision.removeImage) decision = { removeImage: false, reason: 'no-record' };
  const lastKnownOwner = decision.reason === 'incomplete-inventory'
    && Object.hasOwn(format2.owners, ownerKey);
  let lastOwnerHint = null;
  if (lastKnownOwner && !dryRun) {
    const answer = await askRemoval(host, 'last-owner', options);
    if (answer === 'cancel') return { exitCode: 130, output: 'Cancelled; nothing was changed.' };
    if (answer === 'remove') decision = { removeImage: true };
    else lastOwnerHint = removalHint(host);
  }
  const permissionResult = inspection.settingsError === null
    ? await removePermissionRules(host.settingsPath, { dryRun })
    : { removed: 0 };
  const permissionLine = inspection.settingsError === null
    ? permissionOutput(host, permissionResult.removed, dryRun)
    : `Left permission rules in ${host.settingsPath} because settings could not be read: ${inspection.settingsError}`;
  const preservation = preservationText(host);
  const hostMarks = hasPackageMarks(inspection);
  if (!record && !hostMarks) {
    return { exitCode: 1, output: `${permissionLine}\ncodex-bridge is not installed.\n${preservation}` };
  }
  const imageFiles = record && decision.removeImage
    ? record.files.filter((file) => file.root === 'brand') : [];
  const writer = record ? recordHomeWriter(host, record.files) : null;

  if (dryRun) {
    const hostSide = await removeHostSide(host, inspection, { owner, dryRun: true });
    const lines = [permissionLine, ...hostSide.lines,
      ...(hostSide.detached ? imageFiles.map((file) => `Would remove ${displayFile(file)}`) : [])];
    const blockedImageLine = decision.removeImage && !hostSide.detached
      ? `Would leave the shared image in ${host.brandRoot} because this host's hooks could not be removed.`
      : null;
    const imageLine = blockedImageLine || (!decision.removeImage
      ? imageDispositionLine(host, decision, true) : null);
    if (imageLine) lines.push(imageLine);
    if (lastKnownOwner) lines.push(`A real run would ask whether ${host.root} is the last host using ${host.brandRoot}.`);
    if (record?.rules && hostSide.detached) {
      if (registryError) {
        lines.push(`Would leave ${record.rules.path} because the rules ownership registry is invalid; ownership is unknown.`);
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
          lines.push(`Warning: the rules ownership registry was missing; other installations may use ${record.rules.path}.`);
        }
      }
    }
    if (record) {
      lines.push(decision.removeImage && hostSide.detached
        ? 'Would remove the installation record from the brand root.'
        : hostSide.detached
          ? 'Would update the installation record to remove this host.'
          : 'Would leave the installation record because this host\'s hooks could not be removed.');
    }
    lines.push(preservation);
    return {
      exitCode: decision.reason === 'incomplete-inventory' || !hostSide.detached ? 1 : 0,
      output: lines.join('\n'),
    };
  }

  const hostSide = await removeHostSide(host, inspection, { owner });
  // Plan_65 D10 item 4: a host still attached keeps everything it shares — its rules ownership, its
  // place in the record, the old per-host record — so a repeat run after the fix finds it whole.
  const detachedRecord = record && hostSide.detached ? record : null;
  let ownership = null;
  if (detachedRecord && !registryError) {
    try {
      ownership = await removeRulesOwner(host);
    } catch (err) {
      registryError = err;
    }
  }
  const rulesOutput = [];
  if (detachedRecord?.rules) {
    if (registryError) {
      rulesOutput.push(`Left ${record.rules.path} because the rules ownership registry is invalid; ownership is unknown.`);
    } else {
      if (ownership?.owners.length) {
        rulesOutput.push(`Left ${record.rules.path} because ${remainingOwnersText(ownership.owners.length)}.`);
      } else {
        const currentFingerprint = await fileFingerprint(record.rules.path);
        if (currentFingerprint === record.rules.fingerprint) {
          await removeOutside(writer, record.rules.path);
        } else if (currentFingerprint !== null) {
          rulesOutput.push(`Left ${record.rules.path} because its contents changed after installation.`);
        }
      }
      if (!registry) {
        rulesOutput.push(`Warning: the rules ownership registry was missing; other installations may use ${record.rules.path}.`);
      }
    }
  }
  if (decision.removeImage && hostSide.detached) {
    for (const file of imageFiles) await removeRecordedFile(host, writer, file);
  }
  await removeEmpty(host.commandsDir);
  if (decision.removeImage && hostSide.detached && record) {
    try {
      await writer.unlink('install-record', installRecordPath(host));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  } else if (!decision.removeImage && record && hostSide.detached) {
    await removeInstallOwner(host);
  }
  if (detachedRecord) await removeOutside(writer, legacyInstallRecordPath(host));
  await removeEmpty(host.agentsDir);
  await removeEmptyLayout(host.legacyAgentsDir);
  await removeEmptyLayout(host.legacyCommandsDir);
  if (decision.removeImage && hostSide.detached) await removeEmpty(host.brandRoot);
  const blockedImageLine = decision.removeImage && !hostSide.detached
    ? `Left the shared image in ${host.brandRoot} because this host's hooks could not be removed.`
    : null;
  const imageLine = blockedImageLine || (!decision.removeImage
    ? imageDispositionLine(host, decision, false) : null);
  const heading = hostSide.detached
    ? 'Uninstalled codex-bridge.'
    : `Did not finish uninstalling codex-bridge: ${host.root} still has its hooks; fix ${host.settingsPath} and run uninstall again.`;
  const keptRecordLine = record && !hostSide.detached
    ? `Kept ${host.root} in the installation record because its hooks could not be removed.`
    : null;
  return {
    exitCode: decision.reason === 'incomplete-inventory' || !hostSide.detached ? 1 : 0,
    output: [heading, permissionLine, ...hostSide.lines, ...rulesOutput, imageLine, keptRecordLine, lastOwnerHint,
      preservation].filter(Boolean).join('\n'),
  };
}

export async function uninstall(options = {}) {
  const host = options?.host;
  if (!host?.settingsPath) return uninstallInRun(options);
  // A dry run only reads; like install's, it must not wait on or create anything.
  if (options.dryRun === true) return withSettingsRun(host.settingsPath, () => uninstallInRun(options));
  return withLifecycle(
    host,
    'uninstall',
    () => withSettingsRun(host.settingsPath, () => uninstallInRun(options)),
    { ticket: options.lifecycleTicket, waitMs: options.lifecycleWaitMs },
  );
}
