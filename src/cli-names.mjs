/** Names this CLI answers to. */

// Plan_17 §5 found installer and test hook lists drifting; keep executable spellings here so a
// new alias cannot silently bypass the prune guard. Under src/ because the installed guard reads
// it too, and cli/ is not copied into the host.
export const CLI_NAMES = Object.freeze(['codex-bridge', 'codexb']);
