/**
 * Says where run artifacts live.
 *
 * The path used to be built from os.homedir() in two places, which taught the package that it
 * lives inside ~/.claude — outside that folder it had nowhere to write. The value is read on
 * every call, not frozen into a constant, because tests override the variable per case.
 */
import os from 'node:os';
import path from 'node:path';

export function runsRoot() {
  const configured = process.env.CODEX_RUNS_ROOT;
  // Trimmed, not taken literally: a path with a leading or trailing space creates a folder
  // Windows tooling cannot address, and the value usually arrives from a shell or an .env line.
  return configured?.trim() ? configured.trim() : path.join(os.homedir(), '.claude', 'codex-runs');
}
