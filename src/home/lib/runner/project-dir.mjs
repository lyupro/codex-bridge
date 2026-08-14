/** Assigns a stable runs directory to one repository. */
import fs from 'node:fs';
import path from 'node:path';
import { readJsonFileSync } from '../json-file.mjs';
import { projectFolder } from '../write-meta.mjs';

export const PROJECT_MARKER = '.project.json';

const MAX_CANDIDATES = 100;

export function normalizeRepoPath(repoPath) {
  let normalized = path.resolve(repoPath).replaceAll('\\', '/').replace(/\/$/, '');
  if (process.platform === 'win32') normalized = normalized.toLowerCase();
  return normalized;
}

function readMarker(dir) {
  const markerPath = path.join(dir, PROJECT_MARKER);
  if (!fs.existsSync(markerPath)) return null;
  let marker;
  try {
    marker = readJsonFileSync(markerPath);
  } catch (err) {
    throw new Error(`Cannot read project marker ${markerPath}: ${err.cause?.message || err.message}`);
  }
  if (!marker || typeof marker.repo !== 'string' || !marker.repo) {
    throw new Error(`Project marker ${markerPath} must contain a non-empty repo path`);
  }
  return marker;
}

/**
 * Takes ownership of a candidate directory, or reports that someone else got it.
 *
 * Two runners starting at the same moment in equally named repositories pick the
 * same free candidate, and exactly one of them wins each of the two exclusive
 * writes below. Until 2026-08-04 the loser died on `EEXIST` instead of reading
 * the marker the winner had just written — the very collision stage 9 of Plan_9
 * existed to solve.
 */
function claimMarker(dir, repo, wantedRepo) {
  const marker = { repo, created: new Date().toISOString() };
  try {
    fs.writeFileSync(path.join(dir, PROJECT_MARKER), `${JSON.stringify(marker, null, 2)}\n`, { flag: 'wx' });
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const existing = readMarker(dir);
    return Boolean(existing) && normalizeRepoPath(existing.repo) === wantedRepo;
  }
}

function createDir(dir) {
  try {
    fs.mkdirSync(dir);
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    return false;
  }
}

function legacyOwner(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));
  const statuses = entries.map((entry) => {
    try {
      return readJsonFileSync(path.join(dir, entry.name, 'status.json'));
    } catch {
      return null;
    }
  });
  return statuses.find((status) => typeof status?.repo === 'string' && status.repo)?.repo ?? null;
}

function candidateName(base, index) {
  return index === 1 ? base : `${base}-${index}`;
}

export function resolveProjectRunsDir(runsRootPath, repoRoot, { create = true } = {}) {
  const base = projectFolder(repoRoot);
  const wantedRepo = normalizeRepoPath(repoRoot);
  if (create) fs.mkdirSync(runsRootPath, { recursive: true });

  for (let index = 1; index <= MAX_CANDIDATES; index += 1) {
    const name = candidateName(base, index);
    const dir = path.join(runsRootPath, name);
    if (!fs.existsSync(dir)) {
      if (!create) return { dir, name, reason: 'created' };
      if (createDir(dir)) {
        if (claimMarker(dir, repoRoot, wantedRepo)) return { dir, name, reason: 'created' };
        continue;
      }
      // The name was free a moment ago and is not any more: judge it like any other.
    }
    if (!fs.statSync(dir).isDirectory()) {
      throw new Error(`Project runs candidate is not a directory: ${dir}`);
    }

    const marker = readMarker(dir);
    if (marker) {
      if (normalizeRepoPath(marker.repo) === wantedRepo) return { dir, name, reason: 'marker' };
      continue;
    }

    const owner = legacyOwner(dir);
    if (!owner || normalizeRepoPath(owner) === wantedRepo) {
      if (!create) return { dir, name, reason: 'adopted' };
      if (claimMarker(dir, repoRoot, wantedRepo)) return { dir, name, reason: 'adopted' };
      continue;
    }
    // Recording the discovered owner prevents later runs from reinterpreting mixed history.
    if (create) claimMarker(dir, owner, normalizeRepoPath(owner));
  }

  throw new Error(
    `No project runs directory is available for ${repoRoot} after ${MAX_CANDIDATES} candidates. ` +
      `Remove or relocate an obsolete ${base} directory, or choose a different CODEX_RUNS_ROOT.`,
  );
}
