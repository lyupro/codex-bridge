/**
 * Uninstalls one host: its side from an inspection of the package's marks, the shared image only from
 * the record and only once the host is detached, preserving host data and foreign files (Plan_65 D10).
 */
import {
  legacyInstallRecordPath,
  readInstallRecord,
} from './manifest.mjs';
import { imageRemoval } from './install-owners.mjs';
import { asFormat2, readInstallRecordFile } from './install-record.mjs';
import { normalizeRepoPath } from '../src/home/lib/runner/project-dir.mjs';
import { removePermissionRules } from './permissions.mjs';
import { inspectHost, hasPackageMarks } from './host-inspection.mjs';
import { removeHostSide } from './host-removal.mjs';
import { askRemoval, removalHint } from './inventory-removal.mjs';
import { withSettingsRun } from './settings-merge.mjs';
import { withLifecycle } from './lifecycle-transaction.mjs';
import { readRulesRegistry } from './rules-owners.mjs';
import { rulesDryRunLines, removeRulesForHost, remainingOwnersText } from './uninstall-rules.mjs';
import { removeEmpty, removeEmptyLayout } from './remove-layout.mjs';
import { recordHomeWriter, removeOutside } from './record-removal.mjs';
import { buildHomeRemovalPlan } from './home-removal-plan.mjs';
import { executeHomePlan } from './home-plan-execute.mjs';
import { outcomeLines, outcomeExitCode, planLines, planExitCode } from './removal-outcomes.mjs';

function permissionOutput(host, removed, dryRun) {
  const verb = dryRun ? 'Would remove' : 'Removed';
  const plural = removed === 1 ? 'string' : 'strings';
  return `${verb} ${removed} permission rule ${plural} from ${host.settingsPath}.`;
}

// Permission strings live in the same settings.json as the hooks; an unreadable file is left untouched
// and named rather than rewritten, like the hooks themselves (Plan_65 D10 item 4).
export async function removePermissions(host, inspection, dryRun) {
  if (inspection.settingsError !== null) {
    return `Left permission rules in ${host.settingsPath} because \
settings could not be read: ${inspection.settingsError}`;
  }
  const { removed } = await removePermissionRules(host.settingsPath, { dryRun });
  return permissionOutput(host, removed, dryRun);
}

export function stillAttachedLine(host) {
  return `Did not finish uninstalling codex-bridge: ${host.root} still has its hooks; fix \
${host.settingsPath} and run uninstall again.`;
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
    return `${verb} the shared image in ${host.brandRoot} because \
this host has no installation record; its members are unknown.`;
  }
  if (decision.reason === 'other-owners') {
    return `${verb} the shared image in ${host.brandRoot} because ${remainingOwnersText(decision.remaining)}.`;
  }
  return `${verb} the shared image in ${host.brandRoot} because \
the installation inventory is incomplete: other installations may use this home.`;
}

// Plan_65 D9 item 3 as amended by D10 item 4: after the last known owner answered "no", a repeat uninstall
// of ANY host of the home promised a question and printed "not installed" instead. The branch decides from
// the raw record and the inspection only — `legacy` is nobody's host view (D10 item 5) — removes the named
// host's side either way, and removes the image only on "yes" for a detached host.
async function uninstallOrphan(options, inspection, registry) {
  const { host, dryRun = false } = options;
  const promptOptions = { ...options, candidates: options.candidates ?? registry?.owners ?? [] };
  if (dryRun) {
    const permissionLine = await removePermissions(host, inspection, true);
    const hostSide = await removeHostSide(host, inspection, { owner: null, dryRun: true });
    const imagePolicy = { remove: hostSide.detached,
      reason: hostSide.detached ? 'operator confirmed' : 'this host is still attached' };
    const plan = await buildHomeRemovalPlan({ command: 'uninstall', host, packageRoot: options.packageRoot,
      imagePolicy });
    return {
      exitCode: 1,
      output: [permissionLine, ...hostSide.lines,
        `A real run would ask whether to remove the shared image of ${host.brandRoot}: \
no host is recorded as using it.`,
        'If the answer is yes:', ...planLines(plan, { host, detached: hostSide.detached })].join('\n'),
    };
  }

  const answer = await askRemoval(host, 'orphan', promptOptions);
  if (answer === 'cancel') return { exitCode: 130, output: 'Cancelled; nothing was changed.' };

  const permissionLine = await removePermissions(host, inspection, false);
  const hostSide = await removeHostSide(host, inspection, { owner: null });
  const imagePolicy = answer === 'remove'
    ? { remove: hostSide.detached,
      reason: hostSide.detached ? 'operator confirmed' : 'this host is still attached' }
    : { remove: false, reason: 'no host is recorded as using it' };
  const plan = await buildHomeRemovalPlan({ command: 'uninstall', host, packageRoot: options.packageRoot,
    imagePolicy });
  await removeEmpty(host.commandsDir);
  await removeEmpty(host.rulesDir);
  await removeEmpty(host.agentsDir);
  await removeEmptyLayout(host.legacyAgentsDir);
  await removeEmptyLayout(host.legacyCommandsDir);
  const { outcomes } = await executeHomePlan(host, plan,
    { detached: hostSide.detached, imageMembers: plan.imageMembers });

  let imageLine = null;
  let hint = null;
  if (answer === 'remove' && !hostSide.detached) {
    imageLine = `Left the shared image in ${host.brandRoot} because this host's hooks could not be removed.`;
  } else if (answer !== 'remove') {
    imageLine = `Left the shared image in ${host.brandRoot} because no host is recorded as using it \
and the inventory is incomplete.`;
    hint = removalHint(host);
  }

  const hasMarks = hasPackageMarks(inspection);
  const heading = !hostSide.detached
    ? stillAttachedLine(host)
    : hasMarks ? 'Uninstalled codex-bridge.'
      : `No codex-bridge files or hooks were found in ${host.root}.`;
  return {
    exitCode: answer === 'remove' && hostSide.detached ? outcomeExitCode(outcomes) : 1,
    output: [heading, permissionLine, ...hostSide.lines, imageLine, hint, ...outcomeLines(outcomes, { host })]
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
  if (orphaned) return uninstallOrphan(options, inspection, registry);

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
    if (lastKnownOwner) lines.push(`A real run would ask whether ${host.root} is the last host \
using ${host.brandRoot}.`);
    lines.push(...await rulesDryRunLines({
      host, record, registry, registryError, detached: hostSide.detached,
    }));
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
  const rulesResult = await removeRulesForHost({
    host, record, registry, registryError, detached: hostSide.detached, writer,
  });
  const rulesOutput = rulesResult.lines;
  registryError = rulesResult.registryError;
  const { outcomes } = await executeHomePlan(host, plan,
    { detached: hostSide.detached, imageMembers: plan.imageMembers });
  await removeEmpty(host.commandsDir);
  await removeEmpty(host.rulesDir);
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
