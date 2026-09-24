/** Judges dispatcher host behaviour so a silent regression cannot leave the Plan_62 D19 gate trusted. */
import { parseJsonText } from '../src/home/lib/json-file.mjs';
import { PROBE_COMMAND } from './host-contract.mjs';

export const DISPATCHER_CONTRACTS = ['agentIdentity', 'shellStdout', 'shellFailure', 'agentTranscript'];

function inputOf(entry) {
  const input = entry?.payload?.tool_input;
  if (input && typeof input === 'object') return input;
  if (typeof input === 'string') {
    try { return parseJsonText('<hook tool_input>', input); } catch { return {}; }
  }
  return {};
}

function matching(entries, event, command) {
  return entries.filter((entry) => entry?.event === event && inputOf(entry).command === command);
}

function verdict(result, detail) { return { result, detail }; }

export function judgeDispatcherContracts({ entries, hostHealthy, okCommand, failCommand, okOutput, failOutput, agentType, promptToken }) {
  const inconclusive = () => verdict('inconclusive', 'Host did not complete the probe.');
  if (hostHealthy === false) return Object.fromEntries(DISPATCHER_CONTRACTS.map((name) => [name, inconclusive()]));
  const list = Array.isArray(entries) ? entries : [];
  const okPre = matching(list, 'PreToolUse', okCommand);
  const okPost = matching(list, 'PostToolUse', okCommand);
  const failPre = matching(list, 'PreToolUse', failCommand);
  const failPost = matching(list, 'PostToolUse', failCommand);
  const failures = matching(list, 'PostToolUseFailure', failCommand);
  let transcriptVerdict;

  const agentPre = list.filter((entry) => entry?.event === 'PreToolUse' && entry.payload?.agent_id);
  if (!agentPre.length) transcriptVerdict = verdict('inconclusive', 'No agent_id was observed.');
  else {
    const first = agentPre[0];
    if (first.transcript?.error) transcriptVerdict = verdict('changed', `First transcript read failed: ${first.transcript.error}`);
    else {
      let parsed;
      try { parsed = parseJsonText(first.transcript?.path ?? '<transcript>', first.transcript?.firstLine ?? ''); } catch {}
      const content = parsed?.message?.content;
      const text = typeof content === 'string' ? content : Array.isArray(content)
        ? content.filter((part) => part?.type === 'text').map((part) => part.text).join('\n') : '';
      transcriptVerdict = parsed?.type === 'user' && text.includes(promptToken)
        ? verdict('honored', 'First agent transcript line contains the caller prompt.')
        : verdict('changed', 'First agent transcript line is not the caller user prompt.');
    }
  }

  return {
    agentIdentity: !okPre.length ? verdict('inconclusive', 'No delegated successful-command call was observed.')
      : okPre.some((entry) => entry.payload.agent_type === agentType && typeof entry.payload.agent_id === 'string' && entry.payload.agent_id.trim())
        ? verdict('honored', 'Agent type and non-empty agent_id were present.')
        : verdict('changed', 'Successful-command PreToolUse lacked the expected agent_type or non-empty agent_id.'),
    shellStdout: !okPre.length ? verdict('inconclusive', 'No delegated successful-command call was observed.')
      : okPost.some((entry) => typeof entry.payload?.tool_response?.stdout === 'string' && entry.payload.tool_response.stdout.includes(okOutput))
        ? verdict('honored', 'PostToolUse stdout contained the probe output.')
        : verdict('changed', 'PostToolUse stdout did not contain the probe output.'),
    shellFailure: !failPre.length ? verdict('inconclusive', 'No delegated failing-command call was observed.')
      : !failPost.length && failures.some((entry) => typeof entry.payload?.error === 'string'
        && entry.payload.error.startsWith('Exit code 2') && entry.payload.error.includes(failOutput)
        && entry.payload.agent_type === agentType)
        ? verdict('honored', 'Failure event carried the expected agent type and exit details without PostToolUse.')
        : verdict('changed', 'Expected failure event contract was not observed.'),
    agentTranscript: transcriptVerdict,
  };
}

export function dispatcherContractStatus({ record, version }) {
  return DISPATCHER_CONTRACTS.map((contract) => {
    const item = record?.contracts?.[contract];
    let state;
    let message;
    if (version == null) {
      state = 'unknown-host'; message = 'Host version is unknown; dispatcher contracts cannot be judged.';
    } else if (!item) {
      state = 'unverified'; message = `Dispatcher contract ${contract} has never been probed on host ${version}; run ${PROBE_COMMAND}.`;
    } else if (item.version !== version) {
      state = 'stale'; message = `Dispatcher contract ${contract} was recorded for host ${item.version}; run ${PROBE_COMMAND}.`;
    } else if (item.result === 'honored') {
      state = 'verified'; message = `Dispatcher contract ${contract} is verified on host ${version}.`;
    } else if (item.result === 'changed') {
      state = 'changed'; message = `Dispatcher gate cannot be trusted on host ${version}: ${contract} changed; see Plan_62 D19.`;
    } else {
      state = 'unverified'; message = `Dispatcher contract ${contract} has no valid verdict; run ${PROBE_COMMAND}.`;
    }
    return { contract, state, message };
  });
}
