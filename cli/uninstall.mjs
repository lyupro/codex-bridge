/** Uninstalls only recorded files from both roots while preserving host data and foreign files. */
import path from 'node:path';
import {
  definitionForRecordedHook,
  fileFingerprint,
  installRecordPath,
  legacyInstallRecordPath,
  readInstallRecord,
  recordTarget,
} from './manifest.mjs';
import { imageRemoval } from './install-owners.mjs';
import { asFormat2, readInstallRecordFile, removeInstallOwner } from './install-record.mjs';
import { normalizeRepoPath } from '../src/home/lib/runner/project-dir.mjs';
import { removePermissionRules } from './permissions.mjs';
import { hostContractPath } from './host-contract.mjs';
import { askRemoval, removalHint } from './inventory-removal.mjs';
import { brandStateDir } from '../src/home/lib/brand-home.mjs';
import {
  commandFor,
  removeHook,
  withSettingsRun,
} from './settings-merge.mjs';
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
  if (decision.reason === 'other-owners') {
    return `${verb} the shared image in ${host.brandRoot} because ${remainingOwnersText(decision.remaining)}.`;
  }
  return `${verb} the shared image in ${host.brandRoot} because the installation inventory is incomplete: other installations may use this home.`;
}

function hookRemovalSpec(host, hook) {
  const definition = definitionForRecordedHook(hook);
  const target = recordTarget(host, hook);
  const full = commandFor(target);
  const short = `codex-bridge hook ${definition.name}`;
  return {
    event: hook.event,
    matcher: definition.matcher,
    command: hook.command || full,
    alternateCommands: [full, short],
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
  const record = await readInstallRecord(host);
  let decision = imageDecision(rawRecord, host);
  const lastKnownOwner = decision.reason === 'incomplete-inventory'
    && Object.hasOwn(asFormat2(rawRecord, host).owners, normalizeRepoPath(host.root));
  let lastOwnerHint = null;
  if (lastKnownOwner && !dryRun) {
    const answer = await askRemoval(host, 'last-owner', options);
    if (answer === 'cancel') return { exitCode: 130, output: 'Cancelled; nothing was changed.' };
    if (answer === 'remove') decision = { removeImage: true };
    else lastOwnerHint = removalHint(host);
  }
  const permissionResult = await removePermissionRules(host.settingsPath, { dryRun });
  const permissionLine = permissionOutput(host, permissionResult.removed, dryRun);
  const preservation = preservationText(host);
  if (!record) {
    return { exitCode: 1, output: `${permissionLine}\ncodex-bridge is not installed.\n${preservation}` };
  }
  const filesToRemove = record.files.filter((file) => decision.removeImage || file.root !== 'brand');
  const writer = recordHomeWriter(host, record.files);

  if (dryRun) {
    const lines = [permissionLine, ...filesToRemove.map((file) => `Would remove ${displayFile(file)}`)];
    const imageLine = imageDispositionLine(host, decision, true);
    if (imageLine) lines.push(imageLine);
    if (lastKnownOwner) lines.push(`A real run would ask whether ${host.root} is the last host using ${host.brandRoot}.`);
    if (record.rules) {
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
    for (const hook of record.hooks) {
      const definition = definitionForRecordedHook(hook);
      lines.push(`Would remove the ${hook.event} hook ${definition.name} for matcher ${definition.matcher}.`);
    }
    lines.push(decision.removeImage
      ? 'Would remove the installation record from the brand root.'
      : 'Would update the installation record to remove this host.');
    lines.push(preservation);
    return {
      exitCode: decision.reason === 'incomplete-inventory' ? 1 : 0,
      output: lines.join('\n'),
    };
  }

  for (const hook of record.hooks) {
    await removeHook(host.settingsPath, hookRemovalSpec(host, hook), {
      createdGroup: hook.createdGroup === true,
    });
  }
  let ownership = null;
  if (!registryError) {
    try {
      ownership = await removeRulesOwner(host);
    } catch (err) {
      registryError = err;
    }
  }
  const rulesOutput = [];
  if (record.rules) {
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
  for (const file of filesToRemove) {
    await removeRecordedFile(host, writer, file);
  }
  await removeEmpty(host.commandsDir);
  if (decision.removeImage) {
    try {
      await writer.unlink('install-record', installRecordPath(host));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  } else {
    await removeInstallOwner(host);
  }
  await removeOutside(writer, legacyInstallRecordPath(host));
  await removeEmpty(host.agentsDir);
  await removeEmptyLayout(host.legacyAgentsDir);
  await removeEmptyLayout(host.legacyCommandsDir);
  if (decision.removeImage) await removeEmpty(host.brandRoot);
  const imageLine = imageDispositionLine(host, decision, false);
  return {
    exitCode: decision.reason === 'incomplete-inventory' ? 1 : 0,
    output: ['Uninstalled codex-bridge.', permissionLine, ...rulesOutput, imageLine, lastOwnerHint, preservation]
      .filter(Boolean).join('\n'),
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
