/** Plan_63 D11: one rendered protocol must keep every dispatcher on the canonical command. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderDispatcherProtocol } from '../src/home/lib/dispatcher-protocol.mjs';
import { canonicalRunCommand, renderRunCommandTemplate } from '../src/home/lib/dispatcher-command.mjs';
import { ORDER_AGENTS } from '../src/home/lib/order-schema.mjs';
import { orderSpellings } from './order-spelling-scan.mjs';

const placeholder = '<task-file path from the orchestrator>';
const headings = [
  '## Required dispatcher input',
  '## When the host refuses the command',
  '## The only thing you do',
];

for (const agent of ORDER_AGENTS) {
  test(`${agent}: the only bash fence contains exactly the shared command template`, () => {
    const protocol = renderDispatcherProtocol(agent);
    const fences = [...protocol.matchAll(/^```bash\n([^\n]+)\n```$/gm)];
    assert.equal(fences.length, 1);
    assert.equal(protocol.match(/^```/gm).length, 2);
    assert.equal(fences[0][1], renderRunCommandTemplate(agent));
    assert.equal(fences[0][1].replace(placeholder, 'C:/scratch/task.md'),
      canonicalRunCommand(agent, 'task file: C:/scratch/task.md').command);
  });

  test(`${agent}: headings, host refusal and incident warnings remain intact`, () => {
    const protocol = renderDispatcherProtocol(agent);
    assert.deepEqual(protocol.match(/^## .+$/gm), headings);
    // K2/K3 remove the old prompt sections; this guard must survive that migration.
    const hostRefusal = protocol.split(`${headings[1]}\n`)[1].split(`\n${headings[2]}`)[0];
    assert.match(hostRefusal, /that refusal is your final answer/);
    assert.match(hostRefusal, /operator runs `codex-bridge install`/);
    assert.match(hostRefusal, /never call `run-codex.mjs`/);
    assert.match(hostRefusal, /never start the runner through `node`, `npx`, `sh`, `bash`/);
    assert.match(hostRefusal, /never retry the same call in PowerShell/);
    assert.match(hostRefusal, /never split the call over more than one line/);
    assert.match(hostRefusal, /never advise the operator to grant a permission rule on an internal file/);
    for (const incident of ['2026-08-15', '2026-08-03', '2026-08-13']) {
      assert.ok(protocol.includes(incident));
    }
    assert.match(protocol, /one order became six runs/);
    assert.match(protocol, /the run has started,\s+waiting for completion/);
    assert.match(protocol, /subagent ceases to exist immediately after responding/);
    assert.match(protocol, /Inventing any outcome the runner did not print is equally prohibited/);
  });

  test(`${agent}: only the task-file call and current command flags are described`, () => {
    const protocol = renderDispatcherProtocol(agent);
    assert.ok(protocol.includes(`task file: ${placeholder}`));
    assert.match(protocol, /exactly one line/);
    assert.match(protocol, /path must be absolute/);
    assert.match(protocol, /orchestrator wrote with its file tool/);
    assert.match(protocol, /never creates, reads or rewrites it/);
    assert.match(protocol, /permission prompt/);
    assert.match(protocol, /order id, grants and every other value/);
    assert.match(protocol, /runner checks the header, never the dispatcher/);
    assert.match(protocol, /never adds, removes or\s+reorders anything on the command line/);
    assert.match(protocol, /run nothing and return `FAIL — no task file in the call`/);
    for (const flag of ['--no-wait', ...orderSpellings()]) {
      assert.equal(protocol.includes(flag), false, flag);
    }
    assert.deepEqual([...new Set(protocol.match(/--[a-z-]+/g))], ['--agent', '--task-file']);
    assert.doesNotMatch(protocol, /[A-Za-z]:[\\/]|\.lyupro|~[\\/]/);
  });

  test(`${agent}: attaching, refusals and stdout are the only completion path`, () => {
    const protocol = renderDispatcherProtocol(agent);
    assert.ok(protocol.includes('run the identical command again'));
    assert.match(protocol, /RUN=<path> order-id=<id>/);
    assert.match(protocol, /ATTACH=<path> order-id=<id> started=<time>/);
    assert.match(protocol, /blocks until the verdict exists and prints it/);
    assert.match(protocol, /timeout: 1800000/);
    assert.match(protocol, /20-25 minutes/);
    assert.match(protocol, /ceiling kills it, run the identical command again/);
    assert.match(protocol, /Background execution \(`run_in_background`, `&`, `nohup`\) is prohibited/);
    assert.match(protocol, /order id collision, a header problem or a grant problem/);
    assert.match(protocol, /return it as `FAIL` with the runner's text/);
    assert.match(protocol, /Never retry with a changed command or another\s+task file/);
    assert.match(protocol, /next pass is assigned only by the orchestrator/);
    assert.match(protocol, /exact stdout of the attaching call/);
    assert.match(protocol, /Do not add or remove anything/);
    assert.match(protocol, /`STARTED` output of the first call is not a result and is never the response/);
  });
}

test('protocol rendering throws for unknown and missing dispatcher agents', () => {
  for (const agent of ['codex-other', 'toString', 'constructor', '__proto__', undefined, null, 42]) {
    assert.throws(() => renderDispatcherProtocol(agent), /unknown dispatcher agent/);
  }
});
