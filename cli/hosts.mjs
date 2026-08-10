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

function claudePaths(root) {
  return {
    agentsDir: path.join(root, 'agents', 'codex-bridge'),
    commandsDir: path.join(root, 'commands', 'codex-bridge'),
    legacyAgentsDir: path.join(root, 'agents', 'codex'),
    legacyCommandsDir: path.join(root, 'commands', 'codex'),
  };
}

export function resolveHost({
  scope = 'user',
  host,
  cwd = process.cwd(),
  homedir = os.homedir(),
  codexHome,
  brandRoot,
} = {}) {
  const resolvedCodexHome = codexHome || process.env.CODEX_HOME || path.join(homedir, '.codex');
  const codexRulesDir = path.join(resolvedCodexHome, 'rules');
  // Plan_25 moves package-owned runtime files out of foreign Claude settings, whose absolute
  // hook paths caused the package-file-layout incident. Keep the brand root overrideable so tests
  // and later installation steps never need to know the operator's home directory.
  const resolvedBrandRoot = path.resolve(
    brandRoot || process.env.CODEX_BRIDGE_HOME || path.join(homedir, '.lyupro', '.codex-bridge'),
  );
  const brandPaths = {
    brandRoot: resolvedBrandRoot,
    brandHooksDir: path.join(resolvedBrandRoot, 'hooks'),
    brandRunnerDir: path.join(resolvedBrandRoot, 'lib'),
    brandConfigPath: path.join(resolvedBrandRoot, 'config.json'),
    brandConventionsPath: path.join(resolvedBrandRoot, 'conventions.md'),
    brandInstallRecordPath: path.join(resolvedBrandRoot, '.installed.json'),
  };
  if (host) {
    const root = path.resolve(host);
    return {
      root,
      ...claudePaths(root),
      codexRulesDir,
      settingsPath: path.join(root, 'settings.json'),
      scope: 'host',
      ...brandPaths,
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
    ...claudePaths(root),
    codexRulesDir,
    settingsPath: path.join(root, 'settings.json'),
    scope,
    ...brandPaths,
  };
}
