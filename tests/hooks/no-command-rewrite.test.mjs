#!/usr/bin/env node
/**
 * Holds every registered hook to one rule: a hook may not add anything to what the host runs.
 *
 * A neighbouring package spent Plan_7 undoing the opposite habit. Its PreToolUse hook rewrote the
 * agent's command into `<cmd> 2>&1 | tool filter; exit "${PIPESTATUS[0]}"`, and because a host
 * permission rule is matched against the beginning of the FINAL string — and is not applied at all
 * once that string carries a substitution or a compound operator — every command it touched became
 * unresolvable by the operator's own rules. Hooks run before permissions are evaluated, so there is
 * no way to exempt the addition. This package reported those windows on 2026-08-15 while carrying
 * none of the cause; the gate exists so the next clever idea cannot introduce it quietly.
 *
 * The rule is phrased as "the hook may not add anything", not "the wrapper is gone", because the
 * second passes the day someone writes a new wrapper. A hook can only reach the host through the
 * keys of `hookSpecificOutput`, so the gate whitelists the keys that cannot rewrite anything and
 * rejects every other — including a key a future host may invent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_DEFINITIONS } from '../../src/home/lib/hook-definitions.mjs';

const HOOKS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'home', 'hooks');

/**
 * Keys a hook may return. Everything here either refuses the call or speaks to the model after the
 * fact; none of them can alter the string the host executes. `permissionDecision: "allow"` is not
 * on the value whitelist below for a second reason beyond rewriting: the host stopped honouring it
 * between 2.1.119 and 2.1.231, and while it worked it was a blanket auto-approve that bypassed the
 * operator's own deny rules.
 */
const ALLOWED_KEYS = new Set([
  'hookEventName',
  'permissionDecision',
  'permissionDecisionReason',
  'additionalContext',
]);

const ALLOWED_DECISIONS = new Set(['deny', 'ask']);

/** The characters that make a command unresolvable by a host permission rule. */
const FORBIDDEN_IN_COMMAND = ['`', '$(', '${', '&&', '||', '|', ';'];

const PROBE_COMMAND = 'echo hi';

/**
 * The input that makes a hook actually answer, where one exists without a live run fixture.
 *
 * Without these the behavioural checks below inspect almost nothing: on `echo hi` every guard
 * passes silently, and a whitelist that never sees an answer reports nothing. The three hooks
 * missing here (`worktree-lock`, `worktree-witness`, `stop-guard`) refuse only while a run is live,
 * and building that state belongs to their own tests rather than being copied into this gate —
 * for them the source-reading check below is the line that holds.
 */
const REFUSING_PAYLOADS = {
  'prune-guard': { tool_name: 'Bash', tool_input: { command: 'codex-bridge prune codex-bridge -f' } },
  'order-gate': { tool_name: 'Agent', tool_input: { subagent_type: 'codex-scout', prompt: 'do the thing' } },
};

/** A payload shaped for each hook's own event, carrying the probe command where the tool takes one. */
function payloadFor(definition) {
  if (definition.event === 'SubagentStop') {
    return { agent_type: 'no-such-agent', agent_id: 'probe', last_assistant_message: 'probe' };
  }
  if (definition.event === 'PostToolUse') {
    return {
      tool_name: 'Bash',
      tool_input: { command: PROBE_COMMAND },
      tool_response: { stdout: 'hi\n', stderr: '', interrupted: false },
    };
  }
  if (definition.matcher.includes('Agent')) {
    return { tool_name: 'Agent', tool_input: { subagent_type: 'codex-scout', prompt: 'probe' } };
  }
  if (definition.matcher.includes('TaskStop')) {
    return { tool_name: 'TaskStop', tool_input: { subagent_id: 'probe' } };
  }
  return { tool_name: 'Bash', tool_input: { command: PROBE_COMMAND } };
}

/**
 * Runs a hook against an empty runs root. Without the override the answer would depend on whether a
 * run happens to be live on the machine running the suite — the lock would refuse, and a refusal is
 * a legitimate answer, but a gate whose input changes between machines reports the machine rather
 * than the code.
 */
function runHook(definition, runsRoot, payload) {
  const output = execFileSync(process.execPath, [path.join(HOOKS_DIR, definition.file)], {
    input: JSON.stringify(payload ?? payloadFor(definition)),
    encoding: 'utf8',
    env: { ...process.env, CODEX_RUNS_ROOT: runsRoot },
  });
  return output.trim() ? JSON.parse(output) : null;
}

/** Both inputs for one hook: the harmless probe, and the one that makes it speak where it can. */
function answersOf(definition, runsRoot) {
  const answers = [runHook(definition, runsRoot)];
  const refusing = REFUSING_PAYLOADS[definition.name];
  if (refusing) answers.push(runHook(definition, runsRoot, refusing));
  return answers.filter((answer) => answer !== null);
}

function withEmptyRunsRoot(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bridge-rewrite-gate-'));
  try {
    return body(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('no hook returns a key that could change what the host runs', () => {
  withEmptyRunsRoot((runsRoot) => {
    let seen = 0;
    for (const definition of HOOK_DEFINITIONS) {
      for (const result of answersOf(definition, runsRoot)) {
        seen += 1;
        const own = result.hookSpecificOutput;
        assert.ok(own, `${definition.name} answered without hookSpecificOutput`);
        assert.deepEqual(
          Object.keys(result),
          ['hookSpecificOutput'],
          `${definition.name} answered with keys outside hookSpecificOutput`,
        );
        for (const key of Object.keys(own)) {
          assert.ok(
            ALLOWED_KEYS.has(key),
            `${definition.name} returned "${key}": a hook may only refuse or speak, never rewrite`,
          );
        }
        if (own.permissionDecision !== undefined) {
          assert.ok(
            ALLOWED_DECISIONS.has(own.permissionDecision),
            `${definition.name} decided "${own.permissionDecision}"; only deny and ask are ours`,
          );
        }
      }
    }
    // A whitelist that inspected nothing would pass forever; the refusing inputs above exist to
    // keep this number above zero, so their loss is a failure rather than a quieter test.
    assert.ok(seen >= Object.keys(REFUSING_PAYLOADS).length, 'no hook answered — the gate saw nothing');
  });
});

test('no hook hands back a command carrying anything it did not arrive with', () => {
  withEmptyRunsRoot((runsRoot) => {
    for (const definition of HOOK_DEFINITIONS) {
      for (const result of answersOf(definition, runsRoot)) {
        // A refusal reason may name the command; what it may not do is hand back a longer command.
        // Anything quoting the probe is checked for the characters that break a permission rule.
        for (const [key, value] of Object.entries(result.hookSpecificOutput)) {
          if (typeof value !== 'string' || !value.includes(PROBE_COMMAND)) continue;
          const quoted = value.slice(value.indexOf(PROBE_COMMAND), value.indexOf(PROBE_COMMAND) + 64);
          for (const character of FORBIDDEN_IN_COMMAND) {
            assert.ok(
              !quoted.includes(character),
              `${definition.name} put "${character}" next to the command in ${key}`,
            );
          }
        }
      }
    }
  });
});

test('no hook source builds a command line or claims a key that rewrites one', () => {
  // Sources are read as well as behaviour, because a rewriting key returned on a rare branch would
  // pass the probe above and still reach a user. The names are the ones a host uses to replace what
  // it is about to run; `updatedToolOutput` belongs to PostToolUse substitution, which this package
  // deliberately does not do — its PostToolUse hook adds context instead of replacing a result.
  const forbidden = ['updatedInput', 'updatedToolInput', 'updatedToolOutput', 'PIPESTATUS'];
  for (const definition of HOOK_DEFINITIONS) {
    const source = fs.readFileSync(path.join(HOOKS_DIR, definition.file), 'utf8');
    for (const name of forbidden) {
      assert.ok(
        !source.includes(name),
        `${definition.file} mentions ${name}: rewriting what the host runs is a dead end, see the header`,
      );
    }
  }
});
