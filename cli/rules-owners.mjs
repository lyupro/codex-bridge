/** Tracks which Claude Code hosts own the shared Codex bridge rules file. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeRepoPath } from '../src/runner/project-dir.mjs';

export const RULES_REGISTRY_NAME = '.codex-bridge-rules.json';
export const RULES_REGISTRY_VERSION = 1;

export function rulesRegistryPath(host) {
  return path.join(host.codexRulesDir, RULES_REGISTRY_NAME);
}

export function normalizedRulesOwner(host) {
  return normalizeRepoPath(host.root);
}

function normalizeOwners(owners) {
  return [...new Set(owners.map((owner) => normalizeRepoPath(owner)))];
}

function validateRegistry(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('rules ownership registry must be an object');
  }
  if (parsed.version !== RULES_REGISTRY_VERSION) {
    throw new Error(`rules ownership registry version must be ${RULES_REGISTRY_VERSION}`);
  }
  if (!Array.isArray(parsed.owners) || parsed.owners.some((owner) => typeof owner !== 'string' || !owner)) {
    throw new Error('rules ownership registry owners must be a list of non-empty strings');
  }
  return {
    version: RULES_REGISTRY_VERSION,
    owners: normalizeOwners(parsed.owners),
  };
}

async function loadRulesRegistry(host) {
  let raw;
  try {
    raw = await fs.readFile(rulesRegistryPath(host), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid rules ownership registry JSON: ${err.message}`);
  }
  return { raw: parsed, registry: validateRegistry(parsed) };
}

function hasSameOwners(raw, registry) {
  return raw?.version === registry.version
    && Array.isArray(raw.owners)
    && raw.owners.length === registry.owners.length
    && raw.owners.every((owner, index) => owner === registry.owners[index]);
}

async function writeRulesRegistry(host, registry) {
  await fs.mkdir(host.codexRulesDir, { recursive: true });
  await fs.writeFile(rulesRegistryPath(host), `${JSON.stringify(registry, null, 2)}\n`);
}

export async function readRulesRegistry(host) {
  return (await loadRulesRegistry(host))?.registry ?? null;
}

export async function addRulesOwner(host) {
  const loaded = await loadRulesRegistry(host);
  const owner = normalizedRulesOwner(host);
  const current = loaded?.registry || { version: RULES_REGISTRY_VERSION, owners: [] };
  const registry = {
    version: RULES_REGISTRY_VERSION,
    owners: normalizeOwners([...current.owners, owner]),
  };
  if (!loaded || !hasSameOwners(loaded.raw, registry)) await writeRulesRegistry(host, registry);
  return registry;
}

export function remainingRulesOwners(registry, host) {
  if (!registry) return null;
  const owner = normalizedRulesOwner(host);
  return registry.owners.filter((candidate) => candidate !== owner);
}

export async function removeRulesOwner(host) {
  const loaded = await loadRulesRegistry(host);
  if (!loaded) return null;
  const registry = {
    version: RULES_REGISTRY_VERSION,
    owners: remainingRulesOwners(loaded.registry, host),
  };
  if (registry.owners.length) {
    if (!hasSameOwners(loaded.raw, registry)) await writeRulesRegistry(host, registry);
  } else {
    await fs.rm(rulesRegistryPath(host), { force: true });
  }
  return registry;
}
