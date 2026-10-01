/**
 * Asks the operator's permission for removals the installation record cannot prove safe: uninstall's
 * shared image under an incomplete inventory (Plan_65 D9) and purge's two consents (D6, D12 item 5).
 *
 * An old installation record never named every host of the home, so leaving the last KNOWN owner
 * behind, or finding no owner at all, is not proof that nobody else runs from the image. Only the
 * operator can say so; "yes" is that permission, anything else keeps the image with a hint how to
 * come back to the question.
 */
import { askYesNo, isInteractive } from './terminal-question.mjs';
import { readRulesRegistry } from './rules-owners.mjs';
import { registryHintLines } from './inventory-transition.mjs';

const KEPT_DATA = 'config.json, conventions.md and run data stay.';

export function lastOwnerQuestion(host, candidates) {
  return [
    `Home: ${host.brandRoot}`,
    `Known owners: only this host (${host.root}), which is leaving.`,
    'The installation inventory is incomplete: an old installation record did not name every host that used this home.',
    ...registryHintLines(host, candidates),
    `Is ${host.root} the last host using this home? Yes removes the shared image and the installation record; ${KEPT_DATA}`,
  ].join('\n');
}

export function orphanQuestion(host, candidates) {
  return [
    `Home: ${host.brandRoot}`,
    'No host is recorded as using this home, and the inventory is incomplete.',
    ...registryHintLines(host, candidates),
    `Remove the shared image and the installation record of this home? The package's files and hooks in ${host.root} are removed either way; ${KEPT_DATA}`,
  ].join('\n');
}

const QUESTIONS = { 'last-owner': lastOwnerQuestion, orphan: orphanQuestion };

export async function askRemoval(host, kind, options) {
  const question = QUESTIONS[kind];
  if (!question) throw new TypeError(`Unknown inventory removal kind: ${kind}`);
  if (!isInteractive(options)) return 'keep';
  const candidates = options.candidates ?? (await readRulesRegistry(host))?.owners ?? [];
  const answer = await askYesNo(question(host, candidates), options);
  if (answer === 'yes') return 'remove';
  if (answer === 'no') return 'keep';
  return 'cancel';
}

// Plan_65 D6/D12 item 5: purge needs two separate consents, in this order. The first replaces the
// inventory the record cannot prove; the second is the only permission to delete the operator's own data.
export function purgeInventoryQuestion(host, candidates) {
  return [
    `Home: ${host.brandRoot}`,
    `Purge removes this home for good, including what you edited in it. Leaving host: ${host.root}.`,
    ...registryHintLines(host, candidates),
    'Is the inventory complete — does no other host use this home?',
  ].join('\n');
}

export function purgeDataQuestion(host, dataFiles) {
  const listed = dataFiles.length ? dataFiles.map((file) => `  ${file}`) : ['  none found'];
  return [
    `Your data in ${host.brandRoot}:`,
    ...listed,
    'Delete it? This cannot be undone; run artifacts outside the home stay.',
  ].join('\n');
}

/**
 * Asks one purge consent. Unlike askRemoval, "no terminal" is answered here as 'no': purge without
 * a person at the keyboard has no consent to rely on, and the caller refuses rather than keeping.
 */
export async function askPurgeConsent(host, kind, options, detail = []) {
  if (kind !== 'inventory' && kind !== 'data') throw new TypeError(`Unknown purge consent: ${kind}`);
  if (!isInteractive(options)) return 'no';
  const question = kind === 'inventory'
    ? purgeInventoryQuestion(host, options.candidates ?? (await readRulesRegistry(host))?.owners ?? [])
    : purgeDataQuestion(host, detail);
  return askYesNo(question, options);
}

export function removalHint(host) {
  return `Run codex-bridge uninstall --host "${host.root}" again in a terminal to confirm that no other host uses `
    + `${host.brandRoot} and remove it.`;
}
