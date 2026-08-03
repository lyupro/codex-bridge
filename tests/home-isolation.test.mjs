/** Refuses to run the suite against the machine's real Codex home. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

const HOW = 'run the suite with `npm test`, which gives it a Codex home of its own';

test('the suite runs against a throwaway Codex home', () => {
  const codexHome = process.env.CODEX_HOME;
  assert.ok(codexHome, `CODEX_HOME is not set: ${HOW}`);
  const real = path.resolve(os.homedir(), '.codex');
  assert.notEqual(path.resolve(codexHome), real, `CODEX_HOME points at ${real}: ${HOW}`);
  // Installing rules is what reaches outside the repository, and a fixture that forgets to name a
  // Codex home falls back to this variable. Anchoring it under the temp directory keeps that
  // fallback harmless instead of merely unlikely.
  const temporary = path.resolve(os.tmpdir());
  assert.ok(
    path.resolve(codexHome).startsWith(temporary),
    `CODEX_HOME is outside ${temporary}: ${HOW}`,
  );
});
