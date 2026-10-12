/** Catalogues refusals outside order authoring separately from the rules, as required by Plan_79 D3. */

export const DIAGNOSTIC_CATEGORIES = Object.freeze([
  'cli-flags', 'filesystem', 'host-state', 'run-state', 'internal',
]);

export const ORDER_DIAGNOSTICS = Object.freeze({
  'no-wait-grant-conflict': Object.freeze({
    category: 'cli-flags',
    message: ({ grant }) =>
      `--no-wait cannot be combined with a ${grant} grant: ` +
      'checking an existing run must never authorize a new one.',
  }),
});

export function orderDiagnosticMessage(key, values = {}) {
  if (!Object.hasOwn(ORDER_DIAGNOSTICS, key)) throw new Error(`unknown order diagnostic: ${key}`);
  return ORDER_DIAGNOSTICS[key].message(values);
}

export function validateOrderDiagnostics(diagnostics) {
  for (const [key, entry] of Object.entries(diagnostics)) {
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(key)) {
      throw new Error(`invalid order diagnostic key: ${key}`);
    }
    if (!entry || Object.keys(entry).length !== 2 ||
        !['category', 'message'].every((field) => Object.hasOwn(entry, field))) {
      throw new Error(`invalid order diagnostic entry: ${key}`);
    }
    if (!DIAGNOSTIC_CATEGORIES.includes(entry.category)) {
      throw new Error(`unknown order diagnostic category: ${key}`);
    }
    if (typeof entry.message !== 'function') throw new Error(`invalid order diagnostic message: ${key}`);
  }
}
