/**
 * Names where an installation puts package files under a Claude root — one spelling for the
 * installer and the hooks, Plan_67 D10.
 */
import path from 'node:path';

export function claudePaths(root) {
  return {
    agentsDir: path.join(root, 'agents', 'codex-bridge'),
    commandsDir: path.join(root, 'commands', 'codex-bridge'),
    legacyAgentsDir: path.join(root, 'agents', 'codex'),
    legacyCommandsDir: path.join(root, 'commands', 'codex'),
  };
}
