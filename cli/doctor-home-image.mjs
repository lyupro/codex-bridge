/**
 * Compares the installed home image with the package running this command.
 * On 2026-10-21 dev:install copied a newer clone's image beside an older global CLI, which
 * rejected its guidance with "unknown placeholder" while doctor reported a matching version.
 * The record identifies the recorded installation, so its version cannot prove the live image.
 */
import fs from 'node:fs/promises';
import { buildInstallPlan, packageInfo, recordTarget } from './manifest.mjs';
import { plannedContent } from './copy.mjs';
import { check } from './doctor-format.mjs';

export async function homeImageCheck(host, record) {
  try {
    if (!record) return check('homeImage', 'warn', 'Home image was not checked; run codex-bridge install');
    const plan = (await buildInstallPlan(host)).filter((item) => item.root === 'brand');
    const paths = new Set(plan.map((item) => item.relativeToRoot));
    const groups = { missing: [], changed: [], unreadable: [], extra: [] };
    for (const item of plan) {
      const expected = await plannedContent(item, host.brandRoot);
      try {
        const actual = await fs.readFile(item.target);
        if (!actual.equals(expected)) groups.changed.push(item.relativeToRoot);
      } catch (err) {
        groups[err.code === 'ENOENT' || err.code === 'ENOTDIR' ? 'missing' : 'unreadable']
          .push(item.relativeToRoot);
      }
    }
    for (const file of record.files.filter((item) => item.root === 'brand' && !paths.has(item.path))) {
      try {
        await fs.stat(recordTarget(host, file));
        groups.extra.push(file.path);
      } catch (err) {
        if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') groups.unreadable.push(file.path);
      }
    }
    const differences = Object.entries(groups).filter(([, files]) => files.length)
      .map(([group, files]) => `${group}: ${files.slice(0, 5).join(', ')}${files.length > 5 ? `, +${files.length - 5} more` : ''}`);
    if (differences.length) {
      const ownPackage = await packageInfo();
      return check('homeImage', 'fail', `${differences.join('; ')}; the home image does not belong to the package of this command (${ownPackage.name}@${ownPackage.version}); run codex-bridge update --force with this same command to replace it`);
    }
    return check('homeImage', 'ok', `${plan.length} image file(s) on disk match this package`);
  } catch (err) {
    return check('homeImage', 'warn', `Home image could not be checked: ${err.message}`);
  }
}
