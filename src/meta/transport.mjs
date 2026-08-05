/**
 * Where a run's transport errors live, and whether that evidence can be trusted.
 *
 * Quota exhaustion is the one signal that tells the orchestrator not to retry, so it is read
 * only from structured events the CLI itself writes. Text outside that protocol is diagnostic
 * evidence, not a verdict.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readJson } from './paths.mjs';
import { readEvents } from './events.mjs';

const stderrPath = (runDir) => path.join(runDir, 'stderr.log');
const hasJsonContract = (runDir) => {
  const args = readJson(path.join(runDir, 'worker.json'))?.args;
  return Array.isArray(args) && args.includes('--json');
};

/**
 * Artifacts that contradict each other about which contract the run was written under.
 *
 * A current run whose worker reached the end of runCodex() has an events.jsonl file. One whose
 * own args promise `--json` but lacks that file lost evidence after the fact; calling it an
 * archived run would make a quota refusal indistinguishable from a quoted one. The deadline
 * marker remains a second consistency check because the same worker also creates stderr.log.
 */
export function transportGap(runDir, events = readEvents(runDir)) {
  if (hasJsonContract(runDir) && !events.hasStream) {
    return 'artifacts disagree: worker.json requests --json, but events.jsonl is missing; the evidence was damaged, so a quota refusal cannot be told apart from a quoted one';
  }
  const status = readJson(path.join(runDir, 'status.json'));
  if (!status || !('stopped_on_deadline' in status)) return null;
  if (fs.existsSync(stderrPath(runDir))) return null;
  return 'artifacts disagree: this run recorded a deadline watch but has no stderr.log, so a quota signal cannot be told apart from a quoted one';
}
