/** Plan_79 D4: each diagnostic category owns its own file named after it under order-diagnostics/. */
import { DIAGNOSTICS as CLI_FLAGS_DIAGNOSTICS } from './order-diagnostics/cli-flags.mjs';
import { DIAGNOSTICS as FILESYSTEM_ACCESS_DIAGNOSTICS } from './order-diagnostics/filesystem.mjs';
import { DIAGNOSTICS as HOST_STATE_DIAGNOSTICS } from './order-diagnostics/host-state.mjs';
import { DIAGNOSTICS as RUN_STATE_DIAGNOSTICS } from './order-diagnostics/run-state.mjs';
import { DIAGNOSTICS as INTERNAL_DIAGNOSTICS } from './order-diagnostics/internal.mjs';
import { recordOrderText, checkOrderTextParameters } from './order-text-record.mjs';

export const DIAGNOSTIC_CATEGORIES = Object.freeze([
  'cli-flags', 'filesystem', 'host-state', 'run-state', 'internal',
]);

const categories = [CLI_FLAGS_DIAGNOSTICS, FILESYSTEM_ACCESS_DIAGNOSTICS, HOST_STATE_DIAGNOSTICS, RUN_STATE_DIAGNOSTICS, INTERNAL_DIAGNOSTICS];
const keys = new Set();
for (const diagnostics of categories) {
  for (const key of Object.keys(diagnostics)) {
    if (keys.has(key)) throw new Error(`duplicate order diagnostic key: ${key}`);
    keys.add(key);
  }
}
export const ORDER_DIAGNOSTICS = Object.freeze(Object.assign({}, ...categories));

export function orderDiagnosticMessage(key, values = {}) {
  if (!Object.hasOwn(ORDER_DIAGNOSTICS, key)) throw new Error(`unknown order diagnostic: ${key}`);
  checkOrderTextParameters('orderDiagnosticMessage', key, values, ORDER_DIAGNOSTICS[key].data);
  return recordOrderText(ORDER_DIAGNOSTICS[key].message(values));
}

export function validateOrderDiagnostics(diagnostics) {
  for (const [key, entry] of Object.entries(diagnostics)) {
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(key)) {
      throw new Error(`invalid order diagnostic key: ${key}`);
    }
    if (!entry || Object.keys(entry).length !== 3 ||
        !['category', 'message', 'data'].every((field) => Object.hasOwn(entry, field))) {
      throw new Error(`invalid order diagnostic entry: ${key}`);
    }
    if (!DIAGNOSTIC_CATEGORIES.includes(entry.category)) {
      throw new Error(`unknown order diagnostic category: ${key}`);
    }
    if (typeof entry.message !== 'function') throw new Error(`invalid order diagnostic message: ${key}`);
    if (!Array.isArray(entry.data) ||
        ![...entry.data].every((name) => typeof name === 'string' && name.trim()) ||
        new Set(entry.data).size !== entry.data.length) {
      throw new Error(`invalid order diagnostic data: ${key}`);
    }
  }
}
