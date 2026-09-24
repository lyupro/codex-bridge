/** Describes where each guard is installed and how its registration will be spelled. */
import path from 'node:path';
import { HOOK_DEFINITIONS, installedHookPath } from './manifest.mjs';
import { probeHookLauncher } from './launcher-probe.mjs';
import { commandFor, hookRegistration } from './settings-merge.mjs';

/**
 * install.mjs and update.mjs each carried their own copy of this, and the copies had already
 * drifted: one returned `root: 'brand'` on every entry and the other did not. Two copies of the
 * list that decides what goes into the operator's settings.json is the same shape of defect
 * Plan_19 had to reconcile between the installer and the hooks.
 *
 * The short command form requires proof that the PATH launcher dispatches from this home. On
 * 2026-08-11, checking only that a command existed registered hooks against a release without the
 * hook subcommand; on 2026-09-24, matching versions also failed for unreleased clone code.
 */
export function hookTargets(host, env = process.env) {
  const probe = probeHookLauncher({ env, brandRoot: host.brandRoot });
  return HOOK_DEFINITIONS.map((definition) => {
    const target = installedHookPath(host, definition);
    const registration = hookRegistration(definition.name, target, probe);
    const fallback = commandFor(target);
    const alternate = registration.command === fallback
      ? `codex-bridge hook ${definition.name}`
      : fallback;
    return {
      definition,
      target,
      root: 'brand',
      relative: path.relative(host.brandRoot, target).split(path.sep).join('/'),
      registration,
      spec: {
        event: definition.event,
        matcher: definition.matcher,
        command: registration.command,
        alternateCommands: [alternate],
      },
    };
  });
}
