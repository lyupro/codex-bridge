/**
 * Reads which host roots own this home from the installation record, read-only, for hooks.
 * Plan_67 D10 needs every recorded owner; the home image has no cli/ modules.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CLI_NAMES } from './cli-names.mjs';
import { homeArtifact } from './home-registry.mjs';
import { parseJsonText } from './json-file.mjs';
import { orderDiagnosticMessage } from './order-diagnostics.mjs';

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function isFormat2(parsed) {
  return isObject(parsed) && parsed.format === 2;
}

export function readOwnerRoots({ brandRoot }) {
  const file = path.join(brandRoot, homeArtifact('install-record').primary[0]);
  const detail = (problem) => orderDiagnosticMessage('install-record-owners-readable', { file, problem, cli: CLI_NAMES[0] });
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return error.code === 'ENOENT'
      ? { problem: 'missing', detail: detail('missing') }
      : { problem: 'unreadable', detail: detail('unreadable') };
  }

  let parsed;
  try {
    parsed = parseJsonText(file, raw);
  } catch {
    return { problem: 'unreadable', detail: detail('invalid-json') };
  }
  if (!isFormat2(parsed)) {
    return { problem: 'not-format-2', detail: detail('not-format-2') };
  }
  // Plan_67 R2: confirmation refuses ownerless records; enrollment must come first.
  if (!isObject(parsed.owners) || Object.keys(parsed.owners).length === 0) {
    return { problem: 'no-owners', detail: detail('no-owners') };
  }
  if (parsed.inventory !== 'complete') {
    return { problem: 'inventory-incomplete', detail: detail('inventory-incomplete') };
  }
  if (Object.hasOwn(parsed, 'legacy')) {
    return { problem: 'legacy-partition', detail: detail('legacy-partition') };
  }
  const roots = [];
  for (const owner of Object.values(parsed.owners)) {
    if (typeof owner?.root !== 'string' || owner.root.trim().length === 0) {
      return { problem: 'malformed-owner', detail: detail('malformed-owner') };
    }
    roots.push(owner.root);
  }
  return { roots: roots.sort() };
}
