/**
 * Renders the reply rows that explain why a run ended without a usable result.
 * Plan_80 A5: render only stored assessments so the reply says what meta.json says;
 * re-deriving them here could disagree with the frozen evidence used at collection.
 */
export function stopRows(meta) {
  if (!meta.situation) return [];
  const { kind, silence_ms: silence, threshold_ms: threshold, commands } = meta.situation;
  const { automatic, grant } = meta.continuation_eligibility;
  const eligibility = (assessment) =>
    `${assessment.allowed ? 'allowed' : 'blocked'} (${assessment.blocking_reasons.join(', ')})`;
  return [
    `Situation: ${kind} · silence=${silence === null ? 'unknown' : `${silence} ms`} · threshold=${threshold === null ? 'unconfigured' : `${threshold} ms`} · command=${commands.state === null ? 'unknown' : commands.state}`,
    `Continuation: automatic ${eligibility(automatic)} · grant ${eligibility(grant)}`,
    `Treatment: ${meta.treatment.action} · diagnostic only, nothing runs it`,
  ];
}
