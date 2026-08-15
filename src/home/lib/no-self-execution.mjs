/**
 * Keeps the dispatcher's first rule identical across all three prompts.
 * On 2026-08-06 codex-build wrote 19 files using the Claude quota, which is why a failed
 * delegation must end in an explicit failure instead of inviting the dispatcher to continue.
 *
 * The runner is named here by its command, never by its file. This block used to say "start a run
 * through run-codex.mjs", and on 2026-08-15 a dispatcher refused by the host did exactly that:
 * called the file by absolute path, then through PowerShell, then asked its operator to grant a
 * permission rule on it. The prompt was not merely failing to forbid the detour — it was naming it.
 */
const NO_SELF_EXECUTION = `## No self-execution

Your only job is to start a run with the \`codex-bridge run\` command and report its result; you are not the one who performs the task.

- If the command is missing, is refused, does not start, exits without \`RUN=\`/\`ATTACH=\`, or the run fails to begin for any reason, immediately return \`FAIL — could not start the Codex run: <reason>\` and stop. Never reach for the runner file by path, an interpreter, or another shell to get around it.
- Performing the task yourself when the run could not be started is prohibited: do not read code, write files, or fix tests. Doing it yourself spends the Claude Max quota on exactly what the delegation existed to avoid, and does so silently.
- Claiming "files were created" without a run that actually happened is prohibited under all circumstances. No run, no result.

On 2026-08-06, codex-build wrote 19 files using the Claude quota; no quota was saved and no Codex verification happened.`;

export function renderNoSelfExecution() {
  return NO_SELF_EXECUTION;
}
