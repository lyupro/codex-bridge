/**
 * Explains a current run that never reached either of its two output streams.
 *
 * The existing events file is enough to distinguish this shape: an archived folder has no
 * events stream at all, while a folder with an empty stream and silent stderr proves the CLI
 * never started.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readText } from './paths.mjs';

export function startupGap(runDir, events) {
  if (!events?.hasStream || events.hasEvents) return null;
  // Existence before emptiness: a stderr.log that is not there is a missing witness, not a
  // silent one, and the two mean opposite things. Reading an absent file as "" would let a run
  // whose evidence was deleted after the fact pass for a run that never started — the damaged
  // -artifacts check below this one exists precisely to name that case instead.
  const stderr = path.join(runDir, 'stderr.log');
  if (!fs.existsSync(stderr) || readText(stderr)) return null;
  return 'run abandoned at startup: events.jsonl has no events and stderr.log is empty, Codex did not run';
}
