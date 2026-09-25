/**
 * Runs the test suite with every root it can install into replaced by a throwaway one.
 *
 * The installer writes its execpolicy file under `$CODEX_HOME/rules`, so a test that builds a host
 * without naming a Codex home installs into the real one: on 2026-08-03 the suite dropped
 * `codex-bridge.rules` into the operator's `~/.codex/rules/` and the next run failed on the file it
 * had left behind. Passing the isolation through the one command that starts the suite is what
 * makes it unforgettable — a fixture can omit it, this cannot.
 *
 * Plan_25 gave the package a second root outside the repository, and this file was not extended
 * with it: on 2026-08-11 the suite wrote config.json, conventions.md and a lib/obsolete.txt fixture
 * straight into the operator's real `~/.lyupro/.codex-bridge/`, where the stray config then stood
 * in the way of the very migration the release was about. Roots live in one list here so a third
 * one cannot be added without this file being the place it is declared.
 *
 * Plan_62 D22 requires package-home writes to remain removable by artifact id. Plan_65 B1b runs
 * the write audit here so the suite cannot forget to enforce the boundary before creating roots.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ISOLATED_ROOTS } from './isolated-roots.mjs';
import { auditWrites } from './home-write-audit.mjs';
import { HOME_WRITE_INVENTORY } from './home-write-inventory.mjs';
import { readmeText, suiteCountMismatch } from './suite-count.mjs';

// One pattern only: on 2026-09-25 three files passed as three arguments ran just the first, and a
// verification reported green for two files it never touched. Refuse before any root is created.
if (process.argv.length > 3) {
  console.error('run-tests: takes ONE pattern; pass a glob such as "tests/cli/{doctor,install}.test.mjs"');
  process.exit(2);
}

const repositoryRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const { violations } = auditWrites({ repositoryRoot, inventory: HOME_WRITE_INVENTORY });
if (violations.length) {
  for (const { module, sink, problem } of violations) {
    process.stderr.write(`run-tests: home-write audit: ${module} ${sink} — ${problem}\n`);
  }
  process.exit(2);
}

const created = ISOLATED_ROOTS.map((name) => [
  name,
  fs.mkdtempSync(path.join(os.tmpdir(), `codex-bridge-test-${name.toLowerCase()}-`)),
]);
// Fixtures created temporary trees no one removed, so keep them under one disposable root.
const testTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bridge-test-tmp-'));
const pattern = process.argv[2] || 'tests/**/*.test.mjs';
// Only a whole-suite run can judge the README's number; a single file legitimately reports two.
const wholeSuite = !process.argv[2];
const tapFile = wholeSuite
  ? path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bridge-test-summary-')), 'summary.tap')
  : null;

// The spec reporter is named explicitly because the second reporter would otherwise replace it,
// and the operator would lose the live output this command exists to show.
const reporters = tapFile
  ? ['--test-reporter=spec', '--test-reporter-destination=stdout',
    '--test-reporter=tap', `--test-reporter-destination=${tapFile}`]
  : [];

try {
  const result = spawnSync(process.execPath, ['--test', ...reporters, pattern], {
    stdio: 'inherit',
    env: { ...process.env, ...Object.fromEntries(created), CODEX_BRIDGE_TEST_TMP: testTmpRoot },
  });
  process.exitCode = result.status ?? 1;
  if (tapFile && process.exitCode === 0) {
    let tap = null;
    try {
      tap = fs.readFileSync(tapFile, 'utf8');
    } catch {
      tap = null;
    }
    const mismatch = suiteCountMismatch(readmeText(path.join(repositoryRoot, 'README.md')), tap);
    if (mismatch) {
      process.stderr.write(`\nsuite-count: ${mismatch}\n`);
      process.exitCode = 1;
    }
  }
} finally {
  for (const [, directory] of created) fs.rmSync(directory, { recursive: true, force: true });
  fs.rmSync(testTmpRoot, { recursive: true, force: true });
  if (tapFile) fs.rmSync(path.dirname(tapFile), { recursive: true, force: true });
}
