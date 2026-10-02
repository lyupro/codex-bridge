/**
 * Finds a command on PATH the way the host shell would, without starting it.
 * The runner and CLI share this home module because the home never imports cli/ (Plan_60 D2).
 */
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

export function envValue(env, name) {
  const key = Object.keys(env).find((entry) => entry.toLowerCase() === name);
  return key ? env[key] : '';
}

function pathValue(env) {
  return envValue(env, 'path');
}

export function resolveCommandOnPath(name, env = process.env) {
  const extensions = process.platform === 'win32'
    ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')
    : [''];
  for (const directory of pathValue(env).split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(path.resolve(directory), `${name}${extension}`);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
      } catch {
        continue;
      }
    }
  }
  return null;
}
