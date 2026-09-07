/** Reads only the operator's root tier; Plan_56 keeps this separate from package profile pins. */
import fs from 'node:fs';
import path from 'node:path';
import { resolveHost } from './hosts.mjs';

export function readCodexUserTier({ codexHome, homedir } = {}) {
  try {
    const { codexRulesDir } = resolveHost({ codexHome, homedir });
    const configPath = path.join(codexRulesDir, '..', 'config.toml');
    const content = fs.readFileSync(configPath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      if (/^\s*\[/.test(line)) break;
      const match = line.match(/^\s*service_tier\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/);
      if (match) return match[1] ?? match[2];
    }
  } catch {
    // Plan_56: optional user-config provenance must not prevent the profile table from rendering.
  }
  return '';
}
