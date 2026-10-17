/**
 * The one owner of "has this thread moved since its recorded stop", shared by the manual
 * `resume:` grant and the automatic continuation (Plan_80 E17), so the two can never disagree.
 */
import { readSessionActivity } from '../codex-session-log.mjs';

export function threadFreshnessGap({ meta, status, readSession = readSessionActivity }) {
  const session = readSession({ threadId: meta.session_id, startedAt: status.started_at, referenceAt: null });
  if (session.state !== 'observed') {
    return { violation: 'thread-unreadable', values: { state: session.state, reason: session.reason } };
  }
  // Plan_80 E13 guard 4: resuming a thread changed since the frozen stop would reuse a spent grant.
  const recordedAt = meta.stop.session.last_record_at;
  const currentAt = session.last_record_at;
  // An unparsable time would make the comparison false and pass the grant on unknown evidence.
  if (!Number.isFinite(Date.parse(recordedAt)) || !Number.isFinite(Date.parse(currentAt))) {
    return { violation: 'thread-time-unknown', values: { recordedAt, currentAt } };
  }
  if (Date.parse(currentAt) > Date.parse(recordedAt)) {
    return { violation: 'thread-advanced-after-stop', values: { recordedAt, currentAt } };
  }
  return null;
}
