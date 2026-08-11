/** Describes where each guard is installed and how its registration will be spelled. */
import path from 'node:path';
import { HOOK_DEFINITIONS, installedHookPath } from './manifest.mjs';
import { commandFor, hookRegistration } from './settings-merge.mjs';

/**
 * install.mjs and update.mjs each carried their own copy of this, and the copies had already
 * drifted: one returned `root: 'brand'` on every entry and the other did not. Two copies of the
 * list that decides what goes into the operator's settings.json is the same shape of defect
 * Plan_19 had to reconcile between the installer and the hooks.
 *
 * `packageVersion` is what keeps the registration honest: the short command form is only chosen
 * when the codex-bridge on PATH reports this exact version, because on 2026-08-11 an install from
 * the clone wrote `codex-bridge hook <name>` against a global 0.4.0 that has no such subcommand
 * and took every guard on the machine down with it.
 */
export function hookTargets(host, env = process.env, packageVersion = null) {
  return HOOK_DEFINITIONS.map((definition) => {
    const target = installedHookPath(host, definition);
    const registration = hookRegistration(definition.name, target, env, packageVersion);
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
