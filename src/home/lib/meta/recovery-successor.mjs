/**
 * The single reader of the parent -> automatic child relationship (Plan_80 E18).
 * Reads artifacts only: never writes or creates folders.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readJson } from './paths.mjs';
import { abortedPreStart, automaticChildMarker } from './pre-start.mjs';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = (reason) => ({ state: 'invalid', reason });
const IDENTITY_KEYS = [
  'order_id', 'agent', 'slug', 'repo', 'phase', 'task_hash', 'task_hash_scheme', 'continued_from',
];

export function recoverySuccessor(runsRoot, run) {
  const parentStatus = readJson(path.join(runsRoot, run, 'status.json'));
  if (!isObject(parentStatus)) return invalid('parent-status-unreadable');
  if (!Object.hasOwn(parentStatus, 'recovery')) return { state: 'none' };

  const pointer = parentStatus.recovery;
  if (!isObject(pointer)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(pointer))
    || pointer.automatic !== true
    || typeof pointer.child !== 'string' || pointer.child.length === 0) return invalid('pointer-shape');
  const child = pointer.child;
  if (/[\\/]/.test(child) || child === '.' || child === '..' || child === run) return invalid('child-name');
  const childDir = path.join(runsRoot, child);
  let childStatus;
  try {
    if (!fs.statSync(childDir).isDirectory()) return invalid('child-missing');
    childStatus = readJson(path.join(childDir, 'status.json'));
  } catch {
    return invalid('child-missing');
  }
  if (!isObject(childStatus)) return invalid('child-missing');
  if (!automaticChildMarker(childStatus) || childStatus.recovery.parent !== run) {
    return invalid('child-marker');
  }
  if (IDENTITY_KEYS.some((key) => Object.hasOwn(parentStatus, key) !== Object.hasOwn(childStatus, key)
    || parentStatus[key] !== childStatus[key])) return invalid('identity');
  return { state: 'valid', child, childDir, started: !abortedPreStart(childDir) };
}
