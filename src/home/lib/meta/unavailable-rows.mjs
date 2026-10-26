/** Plan_60 D2: pre-start and post-start refusals share the same UNAVAILABLE handoff rows. */
import { orderDiagnosticMessage } from '../order-diagnostics.mjs';
import { line } from './paths.mjs';

export function unavailableRows(signal) {
  return [
    orderDiagnosticMessage('codex-unavailable-handoff', { variant: 'handoff' }),
    orderDiagnosticMessage('codex-unavailable-handoff', { variant: 'signal', signal: line(signal, 170) }),
    orderDiagnosticMessage('next-action', { variant: 'unavailable' }),
    orderDiagnosticMessage('codex-unavailable-handoff', { variant: 'operator-check' }),
  ];
}
