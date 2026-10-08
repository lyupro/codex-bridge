/**
 * Knows the run roots the records moved away from and says where a path under one of them lives now.
 *
 * Plan_77's “Why” paragraph: on 2026-10-07 thousands of run records in another project's
 * git tree made a VaultForge journal compile cost $16.57 instead of $0.3-0.8. D6 forbids
 * redirect links or silent remapping; a corrupt move record must never revive that store.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseJsonText } from '../json-file.mjs';
import { normalizeRepoPath } from './project-dir.mjs';

export const RUNS_MOVE_RECORD = 'runs-root.json';

export function readRunsMoveRecord(stateDir) {
  const file = path.join(stateDir, RUNS_MOVE_RECORD);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Cannot read runs move record ${file}: ${error.message}`, { cause: error });
  }
  let record;
  try {
    record = parseJsonText(file, text);
  } catch (error) {
    throw new Error(`Invalid runs move record ${file}: ${error.message}`, { cause: error });
  }
  const invalid = (defect) => { throw new Error(`Invalid runs move record ${file}: ${defect}`); };
  if (record?.version !== 1) invalid('version must be 1');
  if (!Array.isArray(record.retired) || record.retired.length === 0) {
    invalid('retired must be a non-empty array');
  }
  for (const [index, entry] of record.retired.entries()) {
    if (typeof entry?.root !== 'string' || !path.isAbsolute(entry.root)) {
      invalid(`retired[${index}].root must be an absolute path`);
    }
    if (typeof entry.movedAt !== 'string' || !Number.isFinite(Date.parse(entry.movedAt))) {
      invalid(`retired[${index}].movedAt must be a parseable ISO time`);
    }
  }
  return record;
}

export function retiredRootOf(candidate, retiredRoots) {
  if (typeof candidate !== 'string' || candidate.length === 0) return null;
  const normalized = normalizeRepoPath(candidate);
  for (const { root } of retiredRoots) {
    const retired = normalizeRepoPath(root);
    if (normalized === retired) return { root, suffix: '' };
    if (normalized.startsWith(`${retired}/`)) {
      // Compare normalized paths, but keep the candidate's segment spelling for the advice. Cut by
      // segment count, not by string length: lower-casing can change the length of a non-ASCII name.
      const spelled = path.resolve(candidate).replaceAll('\\', '/').replace(/\/$/, '').split('/');
      return { root, suffix: spelled.slice(retired.split('/').length).join('/') };
    }
  }
  return null;
}

export function retiredRootRefusal({ candidate, retired, destination }) {
  const equivalent = retired.suffix ? path.join(destination, retired.suffix) : destination;
  return `Run records moved from ${retired.root} to ${destination}. Equivalent path: ${equivalent}. ` +
    'Update advice: or pass this new path explicitly. No path was remapped.';
}
