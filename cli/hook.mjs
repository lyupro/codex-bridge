/** Dispatches a named host hook without changing the guard's stdin or process lifecycle. */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HOOK_DEFINITIONS } from '../src/home/lib/hook-definitions.mjs';

const HOOKS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'home', 'hooks');
const VALID_NAMES = HOOK_DEFINITIONS.map(({ name }) => name);

function validNames() {
  return VALID_NAMES.join(', ');
}

function usageError(io, message) {
  io.error(`codex-bridge hook ${message} Valid hook names: ${validNames()}.`);
  return 2;
}

export async function hook(args = [], io = console) {
  if (!Array.isArray(args) || args.length !== 1) {
    const detail = Array.isArray(args) && args.length
      ? `accepts exactly one hook name; received ${args.length}.`
      : 'requires exactly one hook name.';
    return usageError(io, detail);
  }

  const definition = HOOK_DEFINITIONS.find(({ name }) => name === args[0]);
  if (!definition) return usageError(io, `unknown hook name "${args[0]}".`);

  // Plan_25 replaces absolute paths in foreign settings.json with this command. Importing the
  // proven top-level script keeps its stdin reader and process.exit() contract intact; exporting
  // guard functions would be a second implementation of the live hook boundary.
  await import(pathToFileURL(path.join(HOOKS_DIR, definition.file)).href);
  return typeof process.exitCode === 'number' ? process.exitCode : 0;
}
