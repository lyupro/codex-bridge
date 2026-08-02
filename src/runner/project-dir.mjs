/** Assigns a stable runs directory to one repository. */
import fs from 'node:fs';
import path from 'node:path';
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
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read project marker ${markerPath}: ${err.message}`);
  }
  if (!marker || typeof marker.repo !== 'string' || !marker.repo) {
    throw new Error(`Project marker ${markerPath} must contain a non-empty repo path`);
  }
  return marker;
}

function writeMarker(dir, repo) {
  const marker = { repo, created: new Date().toISOString() };
  fs.writeFileSync(path.join(dir, PROJECT_MARKER), `${JSON.stringify(marker, null, 2)}\n`, { flag: 'wx' });
}

function legacyOwner(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));
  const statuses = entries.map((entry) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, entry.name, 'status.json'), 'utf8'));
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
      if (create) {
        fs.mkdirSync(dir);
        writeMarker(dir, repoRoot);
      }
      return { dir, name, reason: 'created' };
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
      if (create) writeMarker(dir, repoRoot);
      return { dir, name, reason: 'adopted' };
    }
    // Recording the discovered owner prevents later runs from reinterpreting mixed history.
    if (create) writeMarker(dir, owner);
  }

  throw new Error(
    `No project runs directory is available for ${repoRoot} after ${MAX_CANDIDATES} candidates. ` +
      `Remove or relocate an obsolete ${base} directory, or choose a different CODEX_RUNS_ROOT.`,
  );
}
