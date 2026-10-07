/**
 * Reads the INSTALLED PACKAGE CONTRACT, unanimous over recorded owners (Plan_67 D10),
 * never a reconstruction of the definition the host selected or its precedence rules.
 * One broken owner makes the shared pin undetermined; this boundary is synchronous and read-only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { claudePaths } from './claude-layout.mjs';
import { CLI_NAMES } from './cli-names.mjs';
import { parseFrontmatter } from './frontmatter.mjs';
import { readOwnerRoots } from './install-owner-roots.mjs';
import { modelFamily } from './model-family.mjs';

export function readDispatcherPin({ brandRoot, agentType }) {
  const owners = readOwnerRoots({ brandRoot });
  if (owners.problem) return { family: null, reasons: [owners.detail] };

  const reasons = [];
  const pins = [];
  for (const root of owners.roots) {
    const file = path.join(claudePaths(root).agentsDir, `${agentType}.md`);
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch (error) {
      const problem = error.code === 'ENOENT' ? 'is missing' : 'cannot be read';
      reasons.push(`Dispatcher file "${file}" ${problem}; repair with ${CLI_NAMES[0]} install --host "${root}".`);
      continue;
    }

    let frontmatter;
    try {
      frontmatter = parseFrontmatter(content);
    } catch {
      frontmatter = null;
    }
    if (frontmatter === null) {
      reasons.push(`The frontmatter in "${file}" is unreadable.`);
      continue;
    }
    if (frontmatter.name !== agentType) {
      reasons.push(`Dispatcher file "${file}" does not declare the required frontmatter name "${agentType}".`);
      continue;
    }
    const family = modelFamily(frontmatter.model);
    if (family === null) {
      reasons.push(`Dispatcher file "${file}" has no parseable model family in its frontmatter model.`);
      continue;
    }
    pins.push({ root, family });
  }

  if (new Set(pins.map(({ family }) => family)).size > 1) {
    const disagreement = pins.map(({ root, family }) => `"${root}" -> ${family}`).join(', ');
    reasons.push(`Installed dispatcher model families disagree across owners: ${disagreement}.`);
  }
  return reasons.length
    ? { family: null, reasons }
    : { family: pins[0].family, roots: owners.roots };
}
