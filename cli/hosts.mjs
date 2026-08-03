/** Resolves Claude Code host paths without touching the filesystem. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function repositoryRoot(start) {
  let current = path.resolve(start);
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(start);
    current = parent;
  }
}

export function resolveHost({
  scope = 'user',
  host,
  cwd = process.cwd(),
  homedir = os.homedir(),
  codexHome,
} = {}) {
  const resolvedCodexHome = codexHome || process.env.CODEX_HOME || path.join(homedir, '.codex');
  const codexRulesDir = path.join(resolvedCodexHome, 'rules');
  if (host) {
    const root = path.resolve(host);
    return {
      root,
      agentsDir: path.join(root, 'agents', 'codex'),
      commandsDir: path.join(root, 'commands', 'codex'),
      codexRulesDir,
      settingsPath: path.join(root, 'settings.json'),
      scope: 'host',
    };
  }
  if (scope !== 'user' && scope !== 'project') {
    throw new Error(`unknown scope "${scope}": expected user or project`);
  }
  const root = path.resolve(
    scope === 'project' ? path.join(repositoryRoot(cwd), '.claude') : path.join(homedir, '.claude'),
  );
  return {
    root,
    agentsDir: path.join(root, 'agents', 'codex'),
    commandsDir: path.join(root, 'commands', 'codex'),
    codexRulesDir,
    settingsPath: path.join(root, 'settings.json'),
    scope,
  };
}
