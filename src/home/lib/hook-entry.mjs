/** Runs the installed home copy so the registering package cannot drift from its live guards. */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HOOK_DEFINITIONS } from './hook-definitions.mjs';

export async function runHook(name, io = console) {
  const definition = HOOK_DEFINITIONS.find(({ name: candidate }) => candidate === name);
  try {
    if (!definition) throw new Error(`unknown hook name "${name}"`);
    // Plan_25 replaces absolute paths in foreign settings.json with this command. Importing the
    // proven top-level script keeps its stdin reader and process.exit() contract intact; exporting
    // guard functions would be a second implementation of the live hook boundary.
    const hooksDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks');
    await import(pathToFileURL(path.join(hooksDir, definition.file)).href);
    return typeof process.exitCode === 'number' ? process.exitCode : 0;
  } catch (error) {
    io.error(`codex-bridge hook: guard "${name}" did not run: ${error?.message ?? String(error)}. Run codex-bridge doctor.`);
    return 1;
  }
}
