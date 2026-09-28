/**
 * Asks uninstall's permission to remove a shared image that an incomplete inventory cannot prove
 * unused (Plan_65 D9).
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

export function removalHint(host) {
  return `Run codex-bridge uninstall --host "${host.root}" again in a terminal to confirm that no other host uses `
    + `${host.brandRoot} and remove it.`;
}
