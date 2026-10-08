/**
 * One resolver says where run artifacts live: CODEX_RUNS_ROOT, moved, legacy, or default.
 *
 * Plan_77 D7 ships code before the move: an existing legacy directory stays active until
 * the move record exists; a clean installation uses the package home immediately. Records
 * in another project's git tree cost a VaultForge journal compile $16.57 instead of $0.3-0.8
 * on 2026-10-07. The value is read on every call, not frozen into a constant, because tests
 * override the variable per case and a verified move must take effect without a restart.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveBrandHome } from '../brand-home.mjs';
import { RUN_RECORDS_DIR } from '../home-registry.mjs';
import { readRunsMoveRecord, retiredRootOf, retiredRootRefusal } from './retired-roots.mjs';

export function runsRootResolution({ env = process.env, homedir = os.homedir() } = {}) {
  const brandHome = resolveBrandHome({ env, homedir });
  const homeRoot = path.join(brandHome.root, RUN_RECORDS_DIR);
  const legacyRoot = path.join(homedir, '.claude', 'codex-runs');
  const record = readRunsMoveRecord(brandHome.stateDir);
  const retired = record?.retired ?? [];
  const configured = env.CODEX_RUNS_ROOT;
  // Trimmed, not taken literally: a path with a leading or trailing space creates a folder
  // Windows tooling cannot address, and the value usually arrives from a shell or an .env line.
  if (configured?.trim()) {
    const root = configured.trim();
    return { root, source: 'CODEX_RUNS_ROOT', legacyRoot, homeRoot, retired,
      staleOverride: retiredRootOf(root, retired) };
  }
  if (record) {
    return { root: homeRoot, source: 'moved', legacyRoot, homeRoot, retired, staleOverride: null };
  }
  const legacyExists = fs.existsSync(legacyRoot) && fs.statSync(legacyRoot).isDirectory();
  return { root: legacyExists ? legacyRoot : homeRoot, source: legacyExists ? 'legacy' : 'default',
    legacyRoot, homeRoot, retired, staleOverride: null };
}

export function runsRoot() {
  const resolution = runsRootResolution();
  if (resolution.staleOverride) throw new Error(staleOverrideRefusal(resolution));
  return resolution.root;
}

/** Plan_77 D6: diagnose the old address before callers read it; never silently remap it. */
export function retiredPathRefusal(candidate, resolution = runsRootResolution()) {
  const retired = retiredRootOf(candidate, resolution.retired);
  return retired ? retiredRootRefusal({ candidate, retired, destination: resolution.homeRoot }) : null;
}

export function staleOverrideRefusal(resolution = runsRootResolution()) {
  if (!resolution.staleOverride) return null;
  return retiredRootRefusal({ candidate: resolution.root, retired: resolution.staleOverride,
    destination: resolution.homeRoot }) + '\n' +
    'CODEX_RUNS_ROOT points under a retired runs root; remove it or set it to the new location.';
}
