/**
 * Keeps the dispatcher's first rule identical across all three prompts.
 * On 2026-08-06 codex-build wrote 19 files using the Claude quota, which is why a failed
 * delegation must end in an explicit failure instead of inviting the dispatcher to continue.
 */
const NO_SELF_EXECUTION = `## No self-execution

Your only job is to start a run through \`run-codex.mjs\` and report its result; you are not the one who performs the task.

- If \`run-codex.mjs\` is missing, does not start, exits without \`RUN=\`/\`ATTACH=\`, or the run fails to begin for any reason, immediately return \`FAIL — could not start the Codex run: <reason>\` and stop.
- Performing the task yourself when the run could not be started is prohibited: do not read code, write files, or fix tests. Doing it yourself spends the Claude Max quota on exactly what the delegation existed to avoid, and does so silently.
- Claiming "files were created" without a run that actually happened is prohibited under all circumstances. No run, no result.

On 2026-08-06, codex-build wrote 19 files using the Claude quota; no quota was saved and no Codex verification happened.`;

export function renderNoSelfExecution() {
  return NO_SELF_EXECUTION;
}
