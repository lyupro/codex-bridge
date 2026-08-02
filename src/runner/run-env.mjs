/**
 * Decides which environment a delegated run gets, and freezes that answer for the whole run.
 *
 * The operator's hooks and plugins belong to interactive work; by default a delegated run
 * does not inherit them. A failing oh-my-codex `Stop` hook would not let Codex end its
 * session, so it quarantined `.omx/state/session.json` to get out — and reported that as
 * the job. It happened twice in production and reproduced on a sterile fixture, 44k tokens
 * of someone else's quota spent on work nobody asked for; with both disabled the same
 * fixture ran the task and cost 23k.
 *
 * Not hardcoded, because "never" is the wrong contract: `node run-config.mjs hooks on`
 * turns either of them back on. A broken run-config.json stops the run instead of quietly
 * falling back — a typo must not decide what environment a run gets.
 */
import { readRunConfig, disableFlags } from '../run-config.mjs';

/**
 * The switches as read (they go to env.json) and the flags they turn into (they go to
 * `codex exec`). Assigned only by loadRunEnv() below, in this module: importers read them
 * through the live binding, which is the only way they could see the loaded value at all.
 */
export let RUN_ENV;
export let CLEAN_ENV;

/**
 * Launcher-only: the worker gets the finished argument list in worker.json and never reads
 * the config again, so a config edited mid-run cannot change the environment of a run that
 * is already going.
 */
export function loadRunEnv() {
  try {
    RUN_ENV = readRunConfig();
    CLEAN_ENV = disableFlags(RUN_ENV);
  } catch (err) {
    console.log(`FAIL — ${err.message}\nПрогон не запускался, квота не потрачена`);
    process.exit(1);
  }
}
