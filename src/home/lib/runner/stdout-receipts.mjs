/**
 * Records the receipt time of Codex stdout in the run folder.
 * Plan_80 S1: stdout lines carry no time, and stdout goes silent earlier than the Codex
 * session log, so receipt times are diagnostics, never the silence signal.
 */
import fs from 'node:fs';
import path from 'node:path';

export function createStdoutReceipts(runDir, onWriteError) {
  const summary = {
    lines: 0, last_received_at: null, incomplete: false, truncated: false, write_error: null,
  };
  let stream;
  let closed = false;
  const fail = (error) => {
    if (summary.write_error !== null) return;
    summary.write_error = error.message;
    // Plan_80 E10/A4: receipts are diagnostics; unlike events.jsonl, their failure must
    // never stop Codex because the verdict does not read them.
    onWriteError(`run-codex: cannot write stdout-receipts.jsonl: ${error.message}\n`);
    stream?.destroy();
  };
  try {
    stream = fs.createWriteStream(path.join(runDir, 'stdout-receipts.jsonl'), { flags: 'a' });
    stream.on('error', fail);
  } catch (error) {
    fail(error);
  }
  const write = (record) => {
    if (summary.write_error !== null) return;
    try { stream.write(`${JSON.stringify(record)}\n`); } catch (error) { fail(error); }
  };
  const record = (offset, bytes, received_at, incomplete) => {
    if (closed || summary.truncated) return;
    summary.lines += 1;
    summary.last_received_at = received_at;
    summary.incomplete ||= incomplete;
    write({ seq: summary.lines, offset, bytes, received_at, ...(incomplete ? { incomplete: true } : {}) });
  };
  return {
    summary,
    recordLine: (offset, bytes, received_at) => record(offset, bytes, received_at, false),
    recordFragment: (offset, bytes, received_at) => record(offset, bytes, received_at, true),
    recordTruncation(received_at, written_bytes) {
      if (closed || summary.truncated) return;
      summary.truncated = true;
      summary.last_received_at = received_at;
      write({ truncated: true, received_at, written_bytes });
    },
    close() {
      closed = true;
      return new Promise((resolve) => {
        if (!stream || stream.closed) return resolve();
        stream.once('close', resolve);
        if (!stream.destroyed) stream.end();
      });
    },
  };
}
