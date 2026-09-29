/**
 * Builds one owner's installation-record row from what is on disk after its files and hooks were written.
 * Install and the owner sync (Plan_65 D7) both advance a row; two copies of this construction would let
 * a synced owner carry fingerprints or `createdGroup` flags that its own install would never write.
 */
import { fileFingerprint } from './manifest.mjs';
import { INSTALL_METHOD_COPY, INSTALL_METHOD_KEY } from './install-record.mjs';

export async function ownerRecord({ plan, rule, targets, hookResults, prior, currentPackage }) {
  const fingerprints = {};
  for (const item of plan) {
    fingerprints[item.root] ??= {};
    fingerprints[item.root][item.relativeToRoot] = await fileFingerprint(item.target);
  }
  const hooks = targets.map(({ definition, relative, registration }, index) => {
    const recorded = prior?.hooks?.find((hook) => hook.event === definition.event
      && hook.root === 'brand' && hook.path === relative);
    // A group we created stays ours after a later run merely joins it; losing the flag would make
    // uninstall leave behind an empty group that only this package ever put there.
    const createdGroup = hookResults[index].createdGroup || recorded?.createdGroup === true;
    const command = registration.command;
    return {
      event: definition.event,
      root: 'brand',
      path: relative,
      command,
      form: command.startsWith('codex-bridge hook ') ? 'short' : 'path',
      ...(createdGroup ? { createdGroup: true } : {}),
    };
  });
  return {
    ...currentPackage,
    installedAt: new Date().toISOString(),
    [INSTALL_METHOD_KEY]: INSTALL_METHOD_COPY,
    files: plan.map((item) => ({ root: item.root, path: item.relativeToRoot })),
    fingerprints,
    rules: { path: rule.target, fingerprint: await fileFingerprint(rule.target) },
    hooks,
  };
}
