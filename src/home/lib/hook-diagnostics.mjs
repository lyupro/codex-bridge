/**
 * Records the last hook input through the home artifact registry. Plan_65 B3 consolidates two
 * duplicated direct writes whose paths must remain purgeable and whose failures must stay fail-open.
 */
import path from 'node:path';
import { BRAND_HOME, brandStateDir } from './brand-home.mjs';
import { createHomeWriter } from './home-write.mjs';

export function recordHookDiagnostic(hookName, input, { root = BRAND_HOME.root } = {}) {
  try {
    const diagnosticsDir = path.join(brandStateDir(root), 'diagnostics');
    const diagnosticFile = path.join(diagnosticsDir, `${hookName}.last.json`);
    const writer = createHomeWriter({ root });
    writer.assertArtifact('diagnostics', diagnosticFile);
    writer.mkdirSync('diagnostics', diagnosticsDir, { recursive: true });
    writer.writeFileSync('diagnostics', diagnosticFile, `${JSON.stringify(input, null, 2)}\n`);
  } catch {
    // Diagnostics are a convenience, never a reason to fail the turn.
  }
}
