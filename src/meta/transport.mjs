/**
 * Where a run's transport errors live, and whether that evidence can be trusted.
 *
 * Quota exhaustion is the one signal that tells the orchestrator not to retry, so it is read
 * only from the stream the CLI itself writes — never from raw.log, which also carries whatever
 * files the run happened to print (Plan_15).
 */
import fs from 'node:fs';
import path from 'node:path';
import { line, readJson, readText } from './paths.mjs';

/**
 * Quota exhaustion is a transport error, not a word. Both markers must sit on the same
 * line: a run whose review text merely discusses "quota exhaustion" is not a run that
 * hit the quota, and reporting LIMIT there tells the orchestrator not to retry when it
 * should. "try again later" is deliberately absent — it is a transient-failure phrase,
 * not a quota one.
 */
const LIMIT_RE = /rate.?limit|usage limit|usage_limit|quota exceeded|quota exhausted|too many requests|\b429\b/i;
const ERROR_RE = /\bERROR\b|error[:=]|stream error|"status"\s*:\s*429|rejected|refused|failed/i;

const stderrPath = (runDir) => path.join(runDir, 'stderr.log');

/**
 * Artifacts that contradict each other about which contract the run was written under.
 *
 * A run whose worker reached the end of runCodex() has both a `stopped_on_deadline` field and
 * a stderr.log — the same call produces them. One without the other means the transport file
 * was lost after the fact, and falling back to raw.log there would silently reinstate the very
 * defect this module exists to remove: the fallback is for archived runs, not for damaged ones.
 */
export function transportGap(runDir) {
  const status = readJson(path.join(runDir, 'status.json'));
  if (!status || !('stopped_on_deadline' in status)) return null;
  if (fs.existsSync(stderrPath(runDir))) return null;
  return 'artifacts disagree: this run recorded a deadline watch but has no stderr.log, so a quota signal cannot be told apart from a quoted one';
}

/**
 * The quota line, or null. Read from stderr.log when the run wrote one; runs from before the
 * split keep being judged by raw.log, since re-judging an archived folder by rules it was never
 * given would rewrite the past. Existence is the marker, never size: an empty stderr.log means
 * stderr stayed silent, which is data.
 */
export function limitSignal(runDir, log) {
  const file = stderrPath(runDir);
  const source = fs.existsSync(file) ? readText(file) : log;
  const hit = source.split(/\r?\n/).find((l) => LIMIT_RE.test(l) && ERROR_RE.test(l));
  return hit ? line(hit) : null;
}
