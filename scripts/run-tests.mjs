/**
 * Runs the test suite with a Codex home of its own.
 *
 * The installer writes its execpolicy file under `$CODEX_HOME/rules`, so a test that builds a host
 * without naming a Codex home installs into the real one: on 2026-08-03 the suite dropped
 * `codex-bridge.rules` into the operator's `~/.codex/rules/` and the next run failed on the file it
 * had left behind. Passing the isolation through the one command that starts the suite is what
 * makes it unforgettable — a fixture can omit it, this cannot.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bridge-test-home-'));
const pattern = process.argv[2] || 'tests/**/*.test.mjs';

try {
  const result = spawnSync(process.execPath, ['--test', pattern], {
    stdio: 'inherit',
    env: { ...process.env, CODEX_HOME: codexHome },
  });
  process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(codexHome, { recursive: true, force: true });
}
