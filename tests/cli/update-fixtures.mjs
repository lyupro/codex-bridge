/** Builds the isolated hosts and outdated installations the update tests start from. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';
import { resolveHost } from '../../cli/hosts.mjs';
import { install } from '../../cli/install.mjs';
import { buildInstallPlan, packageInfo } from '../../cli/manifest.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PACKAGE = await packageInfo();
export const SOURCE = `${PACKAGE.name}@${PACKAGE.version} from ${ROOT} (clone)`;

export async function fixture(t) {
  const root = makeTempTree('bridge-update-');
  t.after(() => removeTempTree(root));
  // Naming the Codex home is not optional: without it the installed rules land in the real one.
  return {
    root,
    host: resolveHost({
      host: path.join(root, 'host'),
      codexHome: path.join(root, 'codex-home'),
      brandRoot: path.join(root, 'brand'),
    }),
  };
}

export async function packageFixture(root, name, { version = '0.0.0', extraFile } = {}) {
  const packageRoot = path.join(root, name);
  await fs.cp(path.join(ROOT, 'src'), path.join(packageRoot, 'src'), { recursive: true });
  const manifest = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  manifest.version = version;
  await fs.writeFile(path.join(packageRoot, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  if (extraFile) await fs.writeFile(path.join(packageRoot, 'src', 'home', extraFile), 'obsolete package file\n');
  return packageRoot;
}

export async function installOutdated(t) {
  const value = await fixture(t);
  const oldPackage = await packageFixture(value.root, 'old-package');
  const oldPlan = await buildInstallPlan(value.host, oldPackage);
  await fs.writeFile(oldPlan[0].source, 'old package content\n');
  await install({ host: value.host, packageRoot: oldPackage });
  const currentPlan = await buildInstallPlan(value.host);
  const changed = currentPlan.find((item) =>
    item.root === oldPlan[0].root && item.relativeToRoot === oldPlan[0].relativeToRoot);
  return { ...value, changed };
}
