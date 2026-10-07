/**
 * Reads which host roots own this home from the installation record, read-only, for hooks.
 * Plan_67 D10 needs every recorded owner; the home image has no cli/ modules.
 */
import fs from 'node:fs';
import path from 'node:path';
import { homeArtifact } from './home-registry.mjs';
import { parseJsonText } from './json-file.mjs';

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function isFormat2(parsed) {
  return isObject(parsed) && parsed.format === 2;
}

export function readOwnerRoots({ brandRoot }) {
  const file = path.join(brandRoot, homeArtifact('install-record').primary[0]);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return error.code === 'ENOENT'
      ? { problem: 'missing', detail: `Installation record at ${file} is missing.` }
      : { problem: 'unreadable', detail: `Installation record at ${file} cannot be read.` };
  }

  let parsed;
  try {
    parsed = parseJsonText(file, raw);
  } catch {
    return { problem: 'unreadable', detail: `Installation record at ${file} contains invalid JSON.` };
  }
  if (!isFormat2(parsed)) {
    return { problem: 'not-format-2', detail: `Installation record at ${file} is not format 2.` };
  }
  if (parsed.inventory !== 'complete') {
    // Plan_67 D11: match cli/inventory-confirm.mjs INVENTORY_CONFIRM_COMMAND; hooks cannot import cli/.
    return { problem: 'inventory-incomplete', detail: `Installation record at ${file} has an incomplete inventory; if the recorded hosts are all the hosts using this home, run codex-bridge inventory confirm.` };
  }
  if (Object.hasOwn(parsed, 'legacy')) {
    return { problem: 'legacy-partition', detail: `Installation record at ${file} contains a legacy partition.` };
  }
  if (!isObject(parsed.owners) || Object.keys(parsed.owners).length === 0) {
    return { problem: 'no-owners', detail: `Installation record at ${file} has no owners.` };
  }
  const roots = [];
  for (const owner of Object.values(parsed.owners)) {
    if (typeof owner?.root !== 'string' || owner.root.trim().length === 0) {
      return { problem: 'malformed-owner', detail: `Installation record at ${file} has an owner without a non-empty root.` };
    }
    roots.push(owner.root);
  }
  return { roots: roots.sort() };
}
