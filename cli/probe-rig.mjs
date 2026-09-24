/** Builds one host run that measures refusal and dispatcher contracts together to avoid charging for separate probes. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROBE_MARKER } from './probe-contract.mjs';

const JOURNAL_NAME = 'probe-journal.log';
const shellQuote = (value) => `"${value.replaceAll('\\', '/').replaceAll('"', '\\"')}"`;

const hookSource = (refusalCommand) => `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const base = path.dirname(fileURLToPath(import.meta.url));
let payload;
try { payload = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { payload = {}; }
const event = process.argv[2];
const entry = { event, payload };
if (event === 'PreToolUse' && payload?.agent_id && payload?.transcript_path && payload?.session_id) {
  const transcriptPath = path.join(path.dirname(payload.transcript_path), payload.session_id, 'subagents', 'agent-' + payload.agent_id + '.jsonl');
  try { entry.transcript = { path: transcriptPath, firstLine: fs.readFileSync(transcriptPath, 'utf8').split(/\\r?\\n/, 1)[0] }; }
  catch (error) { entry.transcript = { path: transcriptPath, error: error.code || error.message }; }
}
try { fs.appendFileSync(path.join(base, '..', 'dispatcher-journal.jsonl'), JSON.stringify(entry) + '\\n', 'utf8'); } catch {}
const refusal = ${JSON.stringify(PROBE_MARKER)};
if (event === 'PreToolUse' && payload?.tool_input?.command === ${JSON.stringify(refusalCommand)}) {
  try { fs.appendFileSync(path.join(base, '..', '${JOURNAL_NAME}'), refusal + '\\n', 'utf8'); } catch {}
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Contract probe refused its marker command.' } }));
}
`;

export async function buildRig(dir, token) {
  const claudeDir = path.join(dir, '.claude');
  const hooksDir = path.join(claudeDir, 'hooks');
  const hookPath = path.join(hooksDir, 'probe-hook.mjs');
  const markerPath = path.join(dir, `${PROBE_MARKER}-${token}.marker`);
  const journalPath = path.join(claudeDir, JOURNAL_NAME);
  const dispatcherJournalPath = path.join(claudeDir, 'dispatcher-journal.jsonl');
  const okCommand = `node -e "console.log('cb-probe-ok-${token}')"`;
  const failCommand = `node -e "console.log('cb-probe-fail-${token}'); console.error('cb-probe-err-${token}'); process.exit(2)"`;
  const refusalCommand = `touch ${PROBE_MARKER}-${token}.marker`;
  const agentPrompt = `probe ${token}: run your two commands`;
  const prompt = `Use the Agent tool with subagent_type "probe-agent" in the foreground and pass it exactly: ${agentPrompt}. Wait for its answer, then run exactly this Bash command and nothing else: ${refusalCommand}`;
  const hook = (event) => ({ matcher: 'Bash', hooks: [{ type: 'command', command: `${shellQuote(process.execPath)} ${shellQuote(hookPath)} ${event}` }] });
  const settings = { hooks: { PreToolUse: [hook('PreToolUse')], PostToolUse: [hook('PostToolUse')], PostToolUseFailure: [hook('PostToolUseFailure')] } };
  const agent = `---\nname: probe-agent\ndescription: Run the dispatcher contract commands.\ntools: Bash\n---\nRun exactly two Bash commands, each as its own call, in the foreground, never retried: first ${okCommand}, then ${failCommand}. Reply with the literal outputs, nothing else.\n`;
  await fs.mkdir(hooksDir, { recursive: true });
  await fs.mkdir(path.join(claudeDir, 'agents'), { recursive: true });
  await fs.writeFile(hookPath, hookSource(refusalCommand), 'utf8');
  await fs.writeFile(path.join(claudeDir, 'agents', 'probe-agent.md'), agent, 'utf8');
  await fs.writeFile(path.join(claudeDir, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return { dir, markerPath, journalPath, dispatcherJournalPath, prompt, token, okCommand, failCommand, refusalCommand, okOutput: `cb-probe-ok-${token}`, failOutput: `cb-probe-fail-${token}` };
}
