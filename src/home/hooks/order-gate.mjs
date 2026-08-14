#!/usr/bin/env node
/**
 * PreToolUse gate for the Codex dispatchers (codex-scout / codex-build / codex-review).
 *
 * The runner rejects a dispatcher immediately when order id (and scope for codex-build) is
 * absent, but the old requirement lived only in the prompt read by the dispatcher. The caller
 * therefore had no enforced place to provide it and codex-build died before doing work. This
 * gate checks the producer's task text while it can still be corrected.
 *
 * Input is Claude Code's hook JSON on stdin. The last payload is retained for diagnostics so a
 * future host schema change can be inspected instead of guessed at. Any uncertain shape passes
 * silently because a diagnostic guard must never break an unrelated tool call.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { diagnoseInput, missingInputs } from '../lib/required-inputs.mjs';
import { SUBAGENT_TOOLS } from '../lib/hook-definitions.mjs';

const HOME = os.homedir();
const LOG_DIR = path.join(HOME, '.claude', 'logs');
const GUARDED = new Set(['codex-scout', 'codex-build', 'codex-review']);
/**
 * Both spellings of the subagent-launching tool, from the same list the installer builds its
 * matcher from. Recognising only the name this host happens to use would make the gate silent
 * on every other host, and a gate that is silent for an unknown reason is worse than none.
 */
const SUBAGENT_TOOL_NAMES = new Set(SUBAGENT_TOOLS);

const pass = () => process.exit(0);

let input;
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch {
  pass();
}

try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(path.join(LOG_DIR, 'codex-order-gate.last.json'), `${JSON.stringify(input, null, 2)}\n`);
} catch {
  // Diagnostics are a convenience, never a reason to fail the turn.
}

if (!input || typeof input !== 'object' || Array.isArray(input)) pass();
if (!SUBAGENT_TOOL_NAMES.has(input.tool_name)) pass();

const toolInput = input.tool_input;
if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) pass();
if (!GUARDED.has(toolInput.subagent_type) || typeof toolInput.prompt !== 'string') pass();

const missing = missingInputs(toolInput.subagent_type, toolInput.prompt);
if (!missing.length) pass();

const reason = [
  'Order gate denied the Agent call because required dispatcher input(s) are missing or still placeholders.',
  'Write each value in tool_input.prompt using `label: value` before launching the dispatcher:',
  ...missing.flatMap((entry) => {
    const lines = [`- ${entry.label}: ${entry.explanation} Example: \`${entry.example}\`.`];
    const diagnosis = diagnoseInput(toolInput.prompt, entry.label);
    if (diagnosis) lines.push(`  found \`${diagnosis.line}\`, ${diagnosis.reason}`);
    return lines;
  }),
].join('\n');

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: reason,
  },
}));
