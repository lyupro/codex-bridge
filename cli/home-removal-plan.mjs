/**
 * Gathers what the removal plan of the home needs and builds it, without changing anything.
 *
 * Plan_65 D12 item 1 combines the registry's fixed paths, recorded image members, and the
 * current package's members: a missing record must remain cleanable, and a member dropped
 * from a newer package must still be found. D12 item 4 keeps corrupt records distinct from
 * missing records so an unreadable installation record blocks removal.
 */
import { asFormat2, imageMembers, readInstallRecordFile } from './install-record.mjs';
import { validateFormat2 } from './install-owners.mjs';
import { imagePackageIndex, judgeImageFile } from './image-evidence.mjs';
import { inspectHome } from './home-inspection.mjs';
import { planHomeRemoval } from './removal-plan.mjs';
import { normalizeRepoPath } from '../src/home/lib/runner/project-dir.mjs';

export async function buildHomeRemovalPlan({ command, host, packageRoot, imagePolicy }) {
  let recordState;
  let format2;
  try {
    const parsed = await readInstallRecordFile(host);
    if (parsed === null) {
      recordState = 'missing';
    } else {
      const candidate = asFormat2(parsed, host);
      validateFormat2(candidate);
      format2 = candidate;
      recordState = 'valid';
    }
  } catch {
    recordState = 'corrupt';
  }

  const packageIndex = await imagePackageIndex(host, packageRoot);
  const recordedMembers = recordState === 'valid'
    ? imageMembers(format2, host).filter((entry) => entry.root === 'brand').map((entry) => entry.path)
    : [];
  const members = [...new Set([...recordedMembers, ...packageIndex.keys()])].sort();
  const inspection = inspectHome(host.brandRoot, { imageMembers: members });
  const fingerprints = recordState === 'valid'
    ? { brand: format2.image.fingerprints?.brand }
    : undefined;
  const imageEvidence = new Map();
  for (const file of inspection.files) {
    if (file.id !== 'install-image' || file.role !== 'primary') continue;
    imageEvidence.set(file.relative, await judgeImageFile(
      host, { root: 'brand', path: file.relative }, fingerprints, packageIndex,
    ));
  }

  return {
    command,
    ...planHomeRemoval({
      command, inspection, imageMembers: members, imageEvidence, imagePolicy,
      recordState, format2, ownerKey: normalizeRepoPath(host.root),
    }),
    recordState,
    homeRoot: inspection.root,
    format2,
    imageMembers: members,
  };
}
