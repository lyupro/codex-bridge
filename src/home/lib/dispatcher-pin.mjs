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
import { orderDiagnosticMessage } from './order-diagnostics.mjs';

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
      const problem = error.code === 'ENOENT' ? 'missing' : 'unreadable';
      reasons.push(orderDiagnosticMessage('dispatcher-pin-file-readable', { file, problem, cli: CLI_NAMES[0], root }));
      continue;
    }

    let frontmatter;
    try {
      frontmatter = parseFrontmatter(content);
    } catch {
      frontmatter = null;
    }
    if (frontmatter === null) {
      reasons.push(orderDiagnosticMessage('dispatcher-pin-frontmatter-readable', { file }));
      continue;
    }
    if (frontmatter.name !== agentType) {
      reasons.push(orderDiagnosticMessage('dispatcher-pin-agent-name', { file, agentType }));
      continue;
    }
    const family = modelFamily(frontmatter.model);
    if (family === null) {
      reasons.push(orderDiagnosticMessage('dispatcher-pin-model-family', { file }));
      continue;
    }
    pins.push({ root, family });
  }

  if (new Set(pins.map(({ family }) => family)).size > 1) {
    const disagreement = pins.map(({ root, family }) => `"${root}" -> ${family}`).join(', ');
    reasons.push(orderDiagnosticMessage('dispatcher-pin-owner-agreement', { disagreement }));
  }
  return reasons.length
    ? { family: null, reasons }
    : { family: pins[0].family, roots: owners.roots };
}
