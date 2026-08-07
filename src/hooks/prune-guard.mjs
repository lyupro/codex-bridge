#!/usr/bin/env node
/**
 * PreToolUse guard that keeps `codex-bridge prune` out of agent-issued shell commands.
 *
 * Deletion is an operator action. The command already refuses without a terminal, but a guard in
 * front of it is the second rubezh Plan_17 asks for: the TTY check lives inside the very process an
 * agent is asking to start, and a package that trusts one check has trusted prose twice before
 * (Plan_13, Plan_14) and been wrong both times. Denying the call means no deleting process is
 * created at all.
 *
 * Anything unrecognised passes. A guard that misreads its input must not break unrelated host work.
 */
import fs from 'node:fs';
import { CLI_NAMES } from '../cli-names.mjs';
import { SHELL_TOOLS } from '../hook-definitions.mjs';

const SHELL_TOOL_NAMES = new Set(SHELL_TOOLS);
const pass = () => process.exit(0);

// The binary, then the verb, with any path in front of it: an agent reaches the CLI as
// `codex-bridge`, as `node bin/codex-bridge.mjs`, or through an absolute path, and a guard that
// only knew the bare name would be bypassed by the spelling everyone uses inside a clone. Plan_19
// adds a second executable spelling, so build this matcher from the shared list instead of
// repeating names here. Matching a lone `prune` is not an option either — `git prune` and
// `npm prune` are not this package's business, and a guard that breaks unrelated work is a guard
// that gets uninstalled.
const escapeRegex = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CLI_NAME_PATTERN = CLI_NAMES.map(escapeRegex).join('|');
const PRUNE_CALL = new RegExp(
  '(^|[\\s;&|(`])(\\S*[\\\\/])?(?:' + CLI_NAME_PATTERN
    + ')(\\.mjs)?\\s+prune(\\s|$)',
);

let input;
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch {
  pass();
}

if (!input || typeof input !== 'object' || Array.isArray(input)) pass();
if (!SHELL_TOOL_NAMES.has(input.tool_name)) pass();

/**
 * Strips the parts of a command line that are data rather than instructions: heredoc bodies and
 * quoted strings. Found the moment this guard existed — it denied the commit that introduced it,
 * because the message text quoted the command name. Nothing was going to be deleted; the words
 * were cargo. A guard that cannot tell an invocation from a mention refuses honest work, and a
 * guard that refuses honest work is removed, after which it guards nothing.
 */
function withoutQuotedText(command) {
  return command
    .replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^\s*\2\s*$/gm, ' ')
    .replace(/'[^']*'/g, ' ')
    .replace(/"[^"]*"/g, ' ');
}

const command = input.tool_input?.command;
if (typeof command !== 'string' || !command.trim()) pass();
if (!PRUNE_CALL.test(withoutQuotedText(command))) pass();

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: 'codex-bridge prune deletes run artifacts and is an operator action, '
      + 'not an agent one. There is deliberately no bypass flag. Ask the operator to run it in '
      + 'their own terminal; `codex-bridge projects` shows the same store read-only.',
  },
}));
