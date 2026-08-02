/**
 * Holds the state of the run in progress and is the only way to answer whoever asked for it.
 *
 * Both halves of the program write here — launcher() and worker() each announce the run they
 * took over — and the crash handler in run-codex.mjs reads it to name the run that just died.
 * The state lives behind functions rather than exported variables because an ES module cannot
 * reassign a binding it imported: as a plain `let` shared across files the crash handler would
 * always have read null and lost the one report a crash is supposed to leave behind.
 */
import fs from 'node:fs';
import path from 'node:path';

let workerDir = null;
let currentRun = null;
let currentAgent = null;

/**
 * Marks this process as the worker half and points it at its run folder. Called once from the
 * CLI entry, before anything else runs: from here on emitReply() answers into reply.txt rather
 * than to a console the worker does not have.
 */
export function setWorkerDir(dir) {
  workerDir = dir;
  currentRun = dir;
}

/** The run this process is working on, for anything that has to report it. */
export function setRun(dir, agent) {
  currentRun = dir;
  currentAgent = agent;
}

export const getRun = () => ({ dir: currentRun, agent: currentAgent });

/**
 * Where the reply goes. The launcher prints it, because its stdout IS the dispatcher's
 * contract. The worker has no stdout at all — it is spawned with stdio 'ignore', since a
 * pipe nobody drains fills up and stalls the run it was supposed to outlive — so it leaves
 * the same text in reply.txt and the launcher prints that. Identical bytes either way.
 */
export function emitReply(text) {
  if (!workerDir) {
    console.log(text);
    return;
  }
  try {
    fs.writeFileSync(path.join(workerDir, 'reply.txt'), `${text}\n`);
  } catch {
    // Disk gone: status.json and meta.json already carry the verdict, and the launcher
    // falls back to them when reply.txt never appears.
  }
}
