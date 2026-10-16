/** Plan_80 E14: count each turn once, across the same thread's resume chain. */
import fs from 'node:fs';
import path from 'node:path';
import { readEvents } from './events.mjs';
import { line, readJson } from './paths.mjs';
import { resumeOrigin } from './sandbox-witness.mjs';

export const EXECUTION_FACT_VERSION = 1;

const canonicalKey = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
const threadKnown = (value) => typeof value === 'string' && value.trim().length > 0;

export function readExecutionFact(runDir, eventData) {
  const run = eventData.hasStream ? eventData.commands_executed : null;
  const chain_runs = [];
  const result = (chain, gap = null) => ({
    version: EXECUTION_FACT_VERSION, run, chain, chain_runs, gap,
  });
  const failure = (name, why) => result(null, `resume chain: ${line(name, 60)} — ${why}`);
  let name = resumeOrigin(readJson(path.join(runDir, 'status.json')));
  if (name === null) return result(run);
  if (!threadKnown(eventData.session_id)) {
    return failure(path.basename(runDir), 'thread id unknown');
  }

  const runsDir = path.dirname(runDir);
  const runsReal = canonicalKey(fs.realpathSync(runsDir));
  const visited = new Set([canonicalKey(fs.realpathSync(runDir))]);
  let total = run ?? 0;
  while (name !== null) {
    if (resumeOrigin({ resumed_from: name }) === null) {
      return failure(name, 'not a bare run folder name');
    }
    const predDir = path.join(runsDir, name);
    try {
      if (!fs.statSync(predDir).isDirectory()) return failure(name, 'run folder not found');
    } catch {
      return failure(name, 'run folder not found');
    }
    let predReal;
    try {
      predReal = fs.realpathSync(predDir);
    } catch {
      return failure(name, "outside this project's runs folder");
    }
    if (canonicalKey(path.dirname(predReal)) !== runsReal) {
      return failure(name, "outside this project's runs folder");
    }
    const key = canonicalKey(predReal);
    if (visited.has(key)) return failure(name, 'cycle in resumed_from');
    visited.add(key);

    const events = readEvents(predDir);
    const meta = readJson(path.join(predDir, 'meta.json'));
    if (events.hasStream && threadKnown(events.session_id) && threadKnown(meta?.session_id)
      && events.session_id !== meta.session_id) {
      return failure(name, 'recorded thread disagrees with its stream');
    }
    const thread = events.hasStream ? events.session_id : meta?.session_id;
    if (!threadKnown(thread)) return failure(name, 'thread id unknown');
    if (thread !== eventData.session_id) return failure(name, 'different thread');

    // E14: stored chain totals would count older turns twice; only this predecessor's run counts.
    const count = events.hasStream ? events.commands_executed : meta?.commands_executed?.run;
    if (!Number.isInteger(count) || count < 0) {
      return failure(name, 'no command evidence (stream pruned, no recorded count)');
    }
    total += count;
    chain_runs.push(name);
    name = resumeOrigin(readJson(path.join(predDir, 'status.json')));
  }
  return result(run === null ? null : total);
}
