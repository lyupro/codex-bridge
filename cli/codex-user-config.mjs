/** Reads only the operator's root tier; Plan_56 keeps this separate from package profile pins. */
import fs from 'node:fs';
import path from 'node:path';
import { resolveHost } from './hosts.mjs';

export function readCodexUserTier(options) {
  // Destructured inside the boundary, not in the signature: a null argument would throw past the
  // catch below, and this reader exists so the profile table renders whatever the file holds.
  try {
    const { codexHome, homedir } = options ?? {};
    const { codexRulesDir } = resolveHost({ codexHome, homedir });
    const configPath = path.join(codexRulesDir, '..', 'config.toml');
    const content = fs.readFileSync(configPath, 'utf8');
    // A multi-line literal can hold anything, including a line that looks like a table header or
    // like this very assignment. Tracking the delimiter keeps text inside a value from being read
    // as configuration — the alternative is answering confidently with someone's prose.
    let openDelimiter = '';
    for (const line of content.split(/\r?\n/)) {
      if (openDelimiter) {
        if (line.includes(openDelimiter)) openDelimiter = '';
        continue;
      }
      const opening = /(?:^|=)\s*("""|''')/.exec(line);
      if (opening && line.split(opening[1]).length === 2) {
        openDelimiter = opening[1];
        continue;
      }
      if (/^\s*\[/.test(line)) break;
      const match = line.match(/^\s*service_tier\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/);
      if (match) return match[1] ?? match[2];
    }
  } catch {
    // Plan_56: optional user-config provenance must not prevent the profile table from rendering.
  }
  return '';
}
