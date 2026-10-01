/**
 * Judges whether an image file may be removed by content evidence (D10 item 3).
 * Plan_65 D12 requires uninstall and the home removal plan to share this read-only judgment,
 * so their protection of operator edits cannot drift into two different implementations.
 */
import fs from 'node:fs/promises';
import { buildInstallPlan, contentFingerprint } from './manifest.mjs';
import { plannedContent } from './copy.mjs';
import { fingerprintFor, recordTarget } from './install-record.mjs';

export async function imagePackageIndex(host, packageRoot) {
  const plan = await buildInstallPlan(host, packageRoot);
  return new Map(plan
    .filter((item) => item.root === 'brand')
    .map((item) => [item.relativeToRoot, item]));
}

export async function judgeImageFile(host, file, fingerprints, packageIndex) {
  const target = recordTarget(host, file);
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT') return { verdict: 'missing', reason: 'missing' };
    return { verdict: 'keep', reason: `unreadable: ${error.code ?? 'UNKNOWN'}` };
  }
  if (stat.isSymbolicLink()) return { verdict: 'keep', reason: 'link' };

  let bytes;
  try {
    bytes = await fs.readFile(target);
  } catch (error) {
    if (error.code === 'ENOENT') return { verdict: 'missing', reason: 'missing' };
    return { verdict: 'keep', reason: `unreadable: ${error.code ?? 'UNKNOWN'}` };
  }

  const recorded = fingerprintFor({ fingerprints }, file);
  const matchesRecord = typeof recorded === 'string' && contentFingerprint(bytes) === recorded;
  if (matchesRecord) return { verdict: 'remove', reason: 'recorded' };
  const item = packageIndex.get(file.path);
  const matchesPackage = item ? bytes.equals(await plannedContent(item, host.brandRoot)) : false;
  if (matchesPackage) return { verdict: 'remove', reason: 'package' };
  return { verdict: 'keep', reason: 'changed' };
}
