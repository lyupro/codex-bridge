/** Recognises whether a dispatcher reply contains every required part of a host refusal. */

const ORDER_ID_PATTERNS = [
  /--order-id(?:=|\s+)[`"']?([a-z0-9][a-z0-9._-]*)/i,
  /\border[\s_-]*id\s*(?::|=)\s*[`"']?([a-z0-9][a-z0-9._-]*)/i,
  /\border[\s_-]*id\s+[`"']([^`"']+)[`"']/i,
];

export function recognizeHostRefusal(reply) {
  const text = String(reply ?? '');
  const declaresFailure = /(^|\n)\s*`*FAIL\b/i.test(text);
  const namesOrderId = ORDER_ID_PATTERNS.some((pattern) => pattern.test(text));
  const namesInstallRemedy = /\bcodex-bridge\s+install\b/i.test(text);
  const missing = [
    ...(!declaresFailure ? ['FAIL declaration'] : []),
    ...(!namesOrderId ? ['order id'] : []),
    ...(!namesInstallRemedy ? ['codex-bridge install remedy'] : []),
  ];
  return { recognized: missing.length === 0, declaresFailure, namesOrderId, namesInstallRemedy, missing };
}
