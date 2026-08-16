/** Parses dispatcher replies into guard facts. */
const STATUSES = ['OK', 'FAIL', 'LIMIT'];

/**
 * Either line names the run folder. `RUN=` is printed by the call that starts a run, `ATTACH=`
 * by the repeat that joins it — and since the launcher stopped waiting, the reply carrying the
 * verdict is the stdout of the attaching call. Matching only `RUN=` would block every honest
 * answer given under the new contract as "did not delegate at all".
 */
export const cleanRunDir = (value) => value.trim().replace(/\s+(?:order-id|started)=.*$/, '').replace(/[`"'*]+$/g, '');

export function parseReply(reply) {
  const runDirs = [...reply.matchAll(/(?:RUN|ATTACH)=(.+?)(?:\r?\n|$)/g)].map((match) => cleanRunDir(match[1]));

  /**
   * Does this reply pronounce a verdict at all? Computed here rather than after meta.json is read,
   * because it decides whether an unnamed folder is worth searching the disk for.
   *
   * Not every honest reply carries one. The runner refuses before creating a folder — a repeat
   * without `--continue`, an impossible `--scope`, a missing `--question` — and its refusal is the
   * whole truthful answer, with no run to name. Escalating those would punish the dispatcher for
   * quoting the runner correctly, and on 2026-08-14 two such refusals arrived in a row.
   */
  const claimed = STATUSES.find((status) => new RegExp(`(^|\\n)\\s*\`*${status}\\b`).test(reply));

  return { runDirs, claimed };
}
