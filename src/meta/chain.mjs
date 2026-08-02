/**
 * Finds the earlier passes of the task a run belongs to.
 *
 * Runs are tied together by slug or by the task text itself, against the repository — all
 * read from the status.json each run writes before Codex is even probed. Nothing here judges
 * a run; it only says which other runs were the same task, so a verdict can be graded against
 * the whole of it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { normalizePath, readJson } from './paths.mjs';

/**
 * What makes two runs the same task when their names disagree.
 *
 * The slug alone cannot answer it: the slug is chosen by whoever repeats the run. On
 * 2026-08-02 a dispatcher lost its launcher to a kill, decided the run had died, and started
 * the identical task again as `<slug>-v2` — 46k of quota on a repeat the --continue gate was
 * built to refuse. Whitespace and case are normalized away because the same order re-sent
 * through a shell is rewrapped, not rewritten; anything more forgiving would tie together
 * tasks that merely look alike.
 */
export const taskFingerprint = (taskText) => {
  const normalized = String(taskText ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  return normalized ? createHash('sha256').update(normalized).digest('hex').slice(0, 16) : '';
};

/**
 * Every run of one task, oldest first — same slug against the same repository. A task is
 * not a run: after a kill or a LIMIT the work is finished by a second pass, and grading
 * that pass against its own delta alone is what produced the false verdict of
 * 2026-07-31_121703, where Codex found its earlier edits already in place, listed them
 * honestly, changed nothing and was told it had done no work. Folder names rather than
 * full paths; the current run joins the list as soon as its status.json exists.
 */
export function chainRuns(runsRoot, repo, slug, taskHash = '') {
  const wantedRepo = normalizePath(repo);
  const wantedSlug = String(slug ?? '').trim().toLowerCase();
  const wantedHash = String(taskHash ?? '').trim().toLowerCase();
  // No handle on the task, or no repo, means nothing to chain — an empty context must find
  // nothing rather than fall back to "every run in this folder".
  if (!wantedRepo || (!wantedSlug && !wantedHash)) return [];
  let entries;
  try {
    entries = fs.readdirSync(runsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const status = readJson(path.join(runsRoot, entry.name, 'status.json'));
    if (!status) continue;
    // Either handle identifies the task. The hash catches a repeat that renamed itself; the
    // slug still catches the follow-up whose wording the orchestrator edited on purpose.
    const sameSlug = Boolean(wantedSlug) && String(status.slug ?? '').trim().toLowerCase() === wantedSlug;
    const sameTask = Boolean(wantedHash) && String(status.task_hash ?? '').trim().toLowerCase() === wantedHash;
    if (!sameSlug && !sameTask) continue;
    if (normalizePath(status.repo) !== wantedRepo) continue;
    runs.push({ name: entry.name, at: String(status.started_at || '') });
  }
  // started_at decides, folder name breaks ties: folders are stamped `<date>_<time>_<slug>`,
  // so they sort the same way for runs written before the field existed.
  runs.sort((a, b) => (a.at === b.at ? (a.name < b.name ? -1 : 1) : a.at < b.at ? -1 : 1));
  return runs.map((r) => r.name);
}

/**
 * The tree as it stood before the task began: state-before.txt of the FIRST run of the
 * chain. The first and not the previous one, because a middle run can end without an
 * "after" snapshot at all — 2026-07-31_114736 wrote eleven files and left neither
 * state-after.txt nor meta.json — and its own "before" is then the last honest base.
 * null when there is no chain or that first run never got a snapshot; an existing but
 * empty snapshot is a clean tree, which is data, not absence.
 */
export function chainBaseline(runsRoot, repo, slug, taskHash = '') {
  const [first] = chainRuns(runsRoot, repo, slug, taskHash);
  if (!first) return null;
  try {
    return fs.readFileSync(path.join(runsRoot, first, 'state-before.txt'), 'utf8');
  } catch {
    return null;
  }
}
