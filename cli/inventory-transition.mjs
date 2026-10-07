/**
 * D9: The inventory becomes incomplete in one transition known before any write; ask then and
 * store nothing about a refusal.
 */
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { askYesNo, isInteractive } from './terminal-question.mjs';
import { isFormat2 } from '../src/home/lib/install-owner-roots.mjs';
import { readInstallRecordFile } from './install-record.mjs';
import { normalizedRulesOwner, readRulesRegistry } from './rules-owners.mjs';

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

export async function detectTransition(host) {
  const [record, homeHadImage] = await Promise.all([
    readInstallRecordFile(host),
    exists(path.join(host.brandRoot, 'lib')),
  ]);
  return {
    transition: (record !== null && !isFormat2(record)) || (record === null && homeHadImage),
    homeHadImage,
  };
}

// The uninstall questions (cli/inventory-removal.mjs) show the same hint: one rendering, one wording.
export function registryHintLines(host, candidates) {
  const owner = normalizedRulesOwner(host);
  const otherCandidates = candidates.filter((root) => root !== owner);
  return [
    'Codex rules registry host roots are a hint only; they may be stale or belong to another home:',
    ...(otherCandidates.length ? otherCandidates.map((root) =>
      `  ${root}${existsSync(root) ? '' : ' (folder does not exist)'}`) : ['  none found']),
  ];
}

export function transitionQuestion(host, candidates) {
  return [
    `Home: ${host.brandRoot}`,
    `Known owners: none yet besides this host (${host.root}).`,
    'The old installation record did not name every host that used this home.',
    ...registryHintLines(host, candidates),
    `Is ${host.root} the only host using this home?`,
  ].join('\n');
}

export async function askTransition(host, options) {
  if (!isInteractive(options)) return 'incomplete';
  const candidates = options.candidates ?? (await readRulesRegistry(host))?.owners ?? [];
  const answer = await askYesNo(transitionQuestion(host, candidates), options);
  if (answer === 'yes') return 'complete';
  if (answer === 'no') return 'incomplete';
  return 'cancel';
}
/** What the operator is told after a transition: which answer was recorded and what it keeps. */
export function transitionOutcome(host, inventory) {
  return inventory === 'complete'
    ? `Recorded this host as the only one using ${host.brandRoot}.`
    : 'The inventory stays incomplete: the shared image is kept until an uninstall confirms no other host uses it.';
}
