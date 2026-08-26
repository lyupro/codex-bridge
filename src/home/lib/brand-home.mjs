/**
 * Resolves where the package's host-side files live: the brand home and the files seeded into it.
 *
 * One resolver, because the rule existed twice and the two copies disagreed. Until 2026-08-26 the
 * runtime built the path to config.json from its own module directory, so `codex-bridge run` read
 * the seed shipped inside the package while the operator edited `~/.lyupro/.codex-bridge/config.json`.
 * A model and an effort pinned there on 5 August never reached a single run — every run silently
 * used defaults, `env.json` recorded `"models": {}`, three releases shipped with it, and `doctor`
 * kept confirming the setting because the CLI resolved the path correctly.
 *
 * The environment and the home directory are injectable so no test needs the operator's real home;
 * `source` is reported because a path chosen by an override and one chosen by default must be
 * distinguishable wherever the setting is shown.
 */
import os from 'node:os';
import path from 'node:path';

export function resolveBrandHome({ homedir = os.homedir(), env = process.env } = {}) {
  const overridden = Boolean(env.CODEX_BRIDGE_HOME);
  const root = path.resolve(
    overridden ? env.CODEX_BRIDGE_HOME : path.join(homedir, '.lyupro', '.codex-bridge'),
  );
  return {
    root,
    source: overridden ? 'CODEX_BRIDGE_HOME' : 'default',
    configPath: path.join(root, 'config.json'),
    conventionsPath: path.join(root, 'conventions.md'),
  };
}

/**
 * Resolved once per process, deliberately: a run reads its configuration in the launcher and must
 * not see the answer change underneath it. Code that needs the answer for another home — a test, an
 * installer targeting `--host` — calls resolveBrandHome() with that home instead of editing the
 * environment after import, which would not be seen here.
 */
export const BRAND_HOME = resolveBrandHome();
export const BRAND_CONFIG_PATH = BRAND_HOME.configPath;
export const BRAND_CONVENTIONS_PATH = BRAND_HOME.conventionsPath;
