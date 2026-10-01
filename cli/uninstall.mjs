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
import { asFormat2, imageMembers, readInstallRecordFile } from './install-record.mjs';
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
import { removeEmpty, removeEmptyHome, removeEmptyLayout } from './remove-layout.mjs';
import { recordHomeWriter, removeOutside } from './record-removal.mjs';
import { removeImageFiles } from './image-removal.mjs';
import { buildHomeRemovalPlan } from './home-removal-plan.mjs';
import { executeHomePlan } from './home-plan-execute.mjs';
import { outcomeLines, outcomeExitCode, planLines, planExitCode } from './removal-outcomes.mjs';

function remainingOwnersText(count) {
  return `${count} other owner${count === 1 ? '' : 's'} ${count === 1 ? 'remains' : 'remain'}`;
}

function permissionOutput(host, removed, dryRun) {
  const verb = dryRun ? 'Would remove' : 'Removed';
  const plural = removed === 1 ? 'string' : 'strings';
  return `${verb} ${removed} permission rule ${plural} from ${host.settingsPath}.`;
}

// Permission strings live in the same settings.json as the hooks; an unreadable file is left untouched
// and named rather than rewritten, like the hooks themselves (Plan_65 D10 item 4).
async function removePermissions(host, inspection, dryRun) {
  if (inspection.settingsError !== null) {
    return `Left permission rules in ${host.settingsPath} because settings could not be read: ${inspection.settingsError}`;
  }
  const { removed } = await removePermissionRules(host.settingsPath, { dryRun });
  return permissionOutput(host, removed, dryRun);
}

// A real uninstall removes ~90 image files; one line per file buried the few that were kept
// (Plan_65 H7). The dry run still lists every file, since there the list is the point.
function realImageLines(host, lines) {
  const removed = lines.filter((line) => line.startsWith('Removed '));
  const kept = lines.filter((line) => !line.startsWith('Removed '));
  return removed.length ? [`Removed ${removed.length} image file(s) from ${host.brandRoot}.`, ...kept] : kept;
}

function stillAttachedLine(host) {
  return `Did not finish uninstalling codex-bridge: ${host.root} still has its hooks; fix ${host.settingsPath} and run uninstall again.`;
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

// Plan_65 D6: uninstalling one host removed the shared image from under every other host of the
// home. Only a record at the old per-host path (no home record at all) keeps the old behavior.
function imageDecision(rawRecord, host) {
  if (rawRecord === null) return { removeImage: true };
  return imageRemoval(asFormat2(rawRecord, host), host);
}

// Plan_65 D12: only a detached last owner permits the plan to remove the shared image.
function imagePolicyFor(decision, hostSide) {
  if (!decision.removeImage) return { remove: false, reason: decision.reason };
  return hostSide.detached
    ? { remove: true, reason: 'last owner' }
    : { remove: false, reason: 'this host is still attached' };
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

// Plan_65 D9 item 3 as amended by D10 item 4: after the last known owner answered "no", a repeat uninstall
// of ANY host of the home promised a question and printed "not installed" instead. The branch decides from
// the raw record and the inspection only — `legacy` is nobody's host view (D10 item 5) — removes the named
// host's side either way, and removes the image only on "yes" for a detached host.
async function uninstallOrphan(options, format2, inspection, registry) {
  const { host, dryRun = false } = options;
  const preservation = preservationText(host);
  const promptOptions = { ...options, candidates: options.candidates ?? registry?.owners ?? [] };
  if (dryRun) {
    const permissionLine = await removePermissions(host, inspection, true);
    const hostSide = await removeHostSide(host, inspection, { owner: null, dryRun: true });
    return {
      exitCode: 1,
      output: [permissionLine, ...hostSide.lines,
        `A real run would ask whether to remove the shared image of ${host.brandRoot}: no host is recorded as using it.`,
        preservation].join('\n'),
    };
  }

  const answer = await askRemoval(host, 'orphan', promptOptions);
  if (answer === 'cancel') return { exitCode: 130, output: 'Cancelled; nothing was changed.' };

  const permissionLine = await removePermissions(host, inspection, false);
  const hostSide = await removeHostSide(host, inspection, { owner: null });
  await removeEmpty(host.commandsDir);
  await removeEmpty(host.agentsDir);
  await removeEmptyLayout(host.legacyAgentsDir);
  await removeEmptyLayout(host.legacyCommandsDir);

  let imageLine;
  let imageLines = [];
  let hint = null;
  if (answer === 'remove' && hostSide.detached) {
    const members = imageMembers(format2, host);
    const removed = await removeImageFiles(
      host,
      members,
      { brand: format2.image.fingerprints?.brand },
      { packageRoot: options.packageRoot },
    );
    imageLines = realImageLines(host, removed.lines);
    const writer = recordHomeWriter(host, members);
    try {
      await writer.unlink('install-record', installRecordPath(host));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    await removeEmptyHome(writer, 'install-image', host.brandRoot);
    imageLine = `Removed the shared image and the installation record of ${host.brandRoot}.`;
  } else if (answer === 'remove') {
    imageLine = `Left the shared image in ${host.brandRoot} because this host's hooks could not be removed.`;
  } else {
    imageLine = `Left the shared image in ${host.brandRoot} because no host is recorded as using it and the inventory is incomplete.`;
    hint = removalHint(host);
  }

  const hasMarks = hasPackageMarks(inspection);
  const heading = !hostSide.detached
    ? stillAttachedLine(host)
    : hasMarks ? 'Uninstalled codex-bridge.'
      : `No codex-bridge files or hooks were found in ${host.root}.`;
  return {
    exitCode: answer === 'remove' && hostSide.detached ? 0 : 1,
    output: [heading, permissionLine, ...hostSide.lines, ...imageLines, imageLine, hint, preservation]
      .filter(Boolean).join('\n'),
  };
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
  const ownerKey = normalizeRepoPath(host.root);
  const format2 = rawRecord === null ? null : asFormat2(rawRecord, host);
  const orphaned = format2 !== null && Object.keys(format2.owners).length === 0;
  const owner = format2?.owners[ownerKey] ?? null;
  // Plan_65 D10: inspect marks and content before permission edits or any other host mutation.
  const inspection = await inspectHost(host, { owner });
  if (orphaned) return uninstallOrphan(options, format2, inspection, registry);

  const record = await readInstallRecord(host);
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
  const permissionLine = await removePermissions(host, inspection, dryRun);
  const hostMarks = hasPackageMarks(inspection);
  if (!record && !hostMarks) {
    return {
      exitCode: 1,
      output: [permissionLine, 'codex-bridge is not installed.', ...outcomeLines([], { host })].join('\n'),
    };
  }
  const writer = record ? recordHomeWriter(host, record.files) : null;

  if (dryRun) {
    const hostSide = await removeHostSide(host, inspection, { owner, dryRun: true });
    const imagePolicy = imagePolicyFor(decision, hostSide);
    const plan = await buildHomeRemovalPlan({ command: 'uninstall', host, packageRoot: options.packageRoot,
      imagePolicy });
    const lines = [permissionLine, ...hostSide.lines];
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
    lines.push(...planLines(plan, { host, detached: hostSide.detached }));
    return {
      exitCode: decision.reason === 'incomplete-inventory' || !hostSide.detached ? 1 : planExitCode(plan),
      output: lines.join('\n'),
    };
  }

  const hostSide = await removeHostSide(host, inspection, { owner });
  const imagePolicy = imagePolicyFor(decision, hostSide);
  const plan = await buildHomeRemovalPlan({ command: 'uninstall', host, packageRoot: options.packageRoot,
    imagePolicy });
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
  const { outcomes } = await executeHomePlan(host, plan,
    { detached: hostSide.detached, imageMembers: plan.imageMembers });
  await removeEmpty(host.commandsDir);
  if (detachedRecord) await removeOutside(writer, legacyInstallRecordPath(host));
  await removeEmpty(host.agentsDir);
  await removeEmptyLayout(host.legacyAgentsDir);
  await removeEmptyLayout(host.legacyCommandsDir);
  const blockedImageLine = decision.removeImage && !hostSide.detached
    ? `Left the shared image in ${host.brandRoot} because this host's hooks could not be removed.`
    : null;
  const imageLine = blockedImageLine || (!decision.removeImage
    ? imageDispositionLine(host, decision, false) : null);
  const heading = hostSide.detached
    ? 'Uninstalled codex-bridge.'
    : stillAttachedLine(host);
  return {
    exitCode: decision.reason === 'incomplete-inventory' || !hostSide.detached ? 1 : outcomeExitCode(outcomes),
    output: [heading, permissionLine, ...hostSide.lines, ...rulesOutput, imageLine, lastOwnerHint,
      ...outcomeLines(outcomes, { host })].filter(Boolean).join('\n'),
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
