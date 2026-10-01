/** Guards Plan_65 D12 items 4 and 7: report facts, preserve reasons, and fail for unsafe removal. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outcomeLines, outcomeExitCode, planLines, planExitCode } from '../../cli/removal-outcomes.mjs';

const host = { brandRoot: '/home/brand', root: '/home/host' };

test('counts actual image and data removals before named keeps, without counting missing entries', () => {
  const outcomes = [
    { kind: 'file', id: 'config', relative: 'config.json', result: 'removed', reason: 'purge' },
    { kind: 'file', id: 'install-image', relative: 'cli.mjs', result: 'removed', reason: 'last owner' },
    { kind: 'file', id: 'install-image', relative: 'lib/a.mjs', result: 'removed', reason: 'last owner' },
    { kind: 'file', id: 'install-image', relative: 'lib/b.mjs', result: 'missing', reason: 'missing' },
    { kind: 'file', id: 'install-image', relative: 'edited.mjs', result: 'kept', reason: 'changed' },
  ];
  const lines = outcomeLines(outcomes, { host });
  assert.equal(lines[0], 'Removed 2 image file(s) from /home/brand.');
  assert.equal(lines[1], 'Removed 1 data file(s) from /home/brand.');
  assert.equal(lines[2], 'Left brand/edited.mjs (changed)');
  assert.equal(lines.length, 4);
  assert.equal(outcomeExitCode(outcomes), 0);
});

test('unknown and protected entries are named, policy-kept image files are not, and none fails the run', () => {
  const outcomes = [
    { kind: 'file', id: null, relative: 'operator.txt', result: 'kept', reason: 'unknown' },
    { kind: 'file', id: 'install-image', relative: 'shared.mjs', result: 'kept', reason: 'other-owners' },
    { kind: 'file', id: null, relative: 'protected.txt', result: 'kept', reason: 'protected' },
  ];
  const lines = outcomeLines(outcomes, { host });
  assert.equal(lines[0], 'Left brand/operator.txt (unknown)');
  assert.equal(lines[1], 'Left brand/protected.txt (protected)');
  assert.equal(lines.some((line) => line.includes('shared.mjs')), false);
  assert.equal(outcomeExitCode(outcomes), 0);
});

test('link and unreadable keeps are named regardless of file id and fail the run', () => {
  const linked = [{ kind: 'file', id: 'config', relative: 'config.json', result: 'kept', reason: 'link at config.json' }];
  const unreadable = [{ kind: 'file', id: 'state', relative: 'state.json', result: 'kept', reason: 'unreadable: EACCES' }];
  const blocked = [{ kind: 'file', id: 'config', relative: 'config.json', result: 'blocked', reason: 'link' }];
  assert.equal(outcomeLines(linked, { host })[0], 'Left brand/config.json (link at config.json)');
  assert.equal(outcomeExitCode(linked), 1);
  assert.equal(outcomeLines(unreadable, { host })[0], 'Left brand/state.json (unreadable: EACCES)');
  assert.equal(outcomeExitCode(unreadable), 1);
  assert.equal(outcomeLines(blocked, { host })[0], 'Left brand/config.json (link)');
  assert.equal(outcomeExitCode(blocked), 1);
  assert.equal(outcomeExitCode([{ kind: 'file', id: null, relative: 'x', result: 'blocked', reason: 'other' }]), 1);
});

test('purge-only files have one sorted line before failures', () => {
  const outcomes = [
    { kind: 'file', id: 'state', relative: 'state/run.json', result: 'kept', reason: 'purge-only' },
    { kind: 'file', id: 'config', relative: 'config.json', result: 'kept', reason: 'purge-only' },
    { kind: 'file', id: 'install-image', relative: 'cli.mjs', result: 'failed', reason: 'EACCES' },
  ];
  const lines = outcomeLines(outcomes, { host });
  assert.equal(lines[0], 'Kept 2 operator file(s) in /home/brand for --purge: config.json, state/run.json');
  assert.equal(lines[1], 'Could not remove brand/cli.mjs: EACCES');
  assert.equal(lines.length, 3);
  assert.equal(outcomeExitCode(outcomes), 1);
});

test('record deletion is distinct from removal of this host and from failed hook detachment', () => {
  const removed = [{ kind: 'record', id: 'install-record', relative: '.installed.json', result: 'removed', reason: 'last owner' }];
  const detached = [
    { kind: 'record', id: 'install-record', relative: '.installed.json', result: 'kept', reason: 'this host removed from the record' },
  ];
  const attached = [
    { kind: 'record', id: 'install-record', relative: '.installed.json', result: 'kept', reason: 'this host is still attached' },
  ];
  assert.equal(outcomeLines(removed, { host })[0], 'Removed the installation record of /home/brand.');
  assert.equal(outcomeLines(removed, { host }).length, 2);
  const detachedLine = 'Removed /home/host from the installation record of /home/brand; the shared image stays.';
  const attachedLine = 'Kept /home/host in the installation record because its hooks could not be removed.';
  assert.equal(outcomeLines(detached, { host })[0], detachedLine);
  assert.equal(outcomeLines(attached, { host })[0], attachedLine);
  assert.equal(outcomeExitCode(detached), 0);
  assert.equal(outcomeExitCode(attached), 0);
});

test('other record keeps, missing records, and record failures retain their exact reasons', () => {
  const kept = [{ kind: 'record', id: 'install-record', relative: '.installed.json', result: 'kept', reason: 'corrupt record' }];
  const missing = [{ kind: 'record', id: 'install-record', relative: '.installed.json', result: 'missing', reason: 'missing' }];
  const failed = [{ kind: 'record', id: 'install-record', relative: '.installed.json', result: 'failed', reason: 'EACCES' }];
  assert.equal(outcomeLines(kept, { host })[0], 'Kept the installation record of /home/brand (corrupt record).');
  assert.equal(outcomeLines(missing, { host }).length, 1);
  assert.equal(outcomeLines(failed, { host })[0], 'Could not remove brand/.installed.json: EACCES');
  assert.equal(outcomeExitCode(failed), 1);
});

test('record temporaries are data files, and the record line comes only from the record outcome', () => {
  const outcomes = [
    { kind: 'file', id: 'install-record', relative: '.installed.json.tmp', result: 'removed', reason: 'record deleted' },
    { kind: 'file', id: null, relative: 'unknown.txt', result: 'kept', reason: 'unknown' },
    { kind: 'record', id: 'install-record', relative: '.installed.json', result: 'removed', reason: 'last owner' },
  ];
  const lines = outcomeLines(outcomes, { host });
  assert.equal(lines[0], 'Removed 1 data file(s) from /home/brand.');
  assert.equal(lines[1], 'Left brand/unknown.txt (unknown)');
  assert.equal(lines[2], 'Removed the installation record of /home/brand.');
});

test('folders are told apart by their kind, not by their position after the record', () => {
  const outcomes = [
    { kind: 'file', id: null, relative: 'unknown.txt', result: 'kept', reason: 'unknown' },
    { kind: 'record', id: 'install-record', relative: '.installed.json', result: 'missing', reason: 'missing' },
    { kind: 'directory', id: null, relative: 'lib/runner', result: 'kept', reason: 'link at lib/runner' },
    { kind: 'directory', id: null, relative: 'lib/empty', result: 'removed', reason: 'image' },
    { kind: 'directory', id: null, relative: 'lib/failed', result: 'failed', reason: 'EACCES' },
    { kind: 'directory', id: null, relative: 'lib/missing', result: 'missing', reason: 'missing' },
    { kind: 'directory', id: null, relative: '', result: 'removed', reason: 'image' },
  ];
  const lines = outcomeLines(outcomes, { host });
  assert.equal(lines[0], 'Left brand/unknown.txt (unknown)');
  assert.equal(lines[1], 'Left brand/lib/runner/ (link at lib/runner)');
  assert.equal(lines[2], 'Could not remove brand/lib/failed/: EACCES');
  assert.equal(lines[3], 'Removed /home/brand.');
  assert.equal(lines.length, 5);
  assert.equal(outcomeExitCode(outcomes), 1);
  assert.equal(outcomeExitCode([outcomes[2]]), 1);
});

test('a removed root alone is not counted as a removed data file', () => {
  const outcomes = [{ kind: 'directory', id: null, relative: '', result: 'removed', reason: 'image' }];
  assert.equal(outcomeLines(outcomes, { host })[0], 'Removed /home/brand.');
  assert.equal(outcomeLines(outcomes, { host }).length, 2);
});

test('dry run counts planned removals and names an edited image and unsafe or unknown rows', () => {
  const plan = {
    rows: [
      { kind: 'file', id: 'install-image', relative: 'cli.mjs', action: 'remove', reason: 'last owner' },
      { kind: 'file', id: 'config', relative: 'config.json', action: 'remove', reason: 'purge' },
      { kind: 'file', id: 'install-image', relative: 'edited.mjs', action: 'keep', reason: 'changed' },
      { kind: 'file', id: null, relative: 'unknown.txt', action: 'keep', reason: 'unknown' },
      { kind: 'file', id: 'state', relative: 'state.json', action: 'blocked', reason: 'unreadable: EACCES' },
      { kind: 'file', id: 'install-image', relative: 'missing.mjs', action: 'missing', reason: 'missing' },
    ],
    record: { operation: 'none', reason: 'missing' },
    directories: [],
  };
  const lines = planLines(plan, { host });
  assert.equal(lines[0], 'Would remove 1 image file(s) from /home/brand.');
  assert.equal(lines[1], 'Would remove 1 data file(s) from /home/brand.');
  assert.equal(lines[2], 'Would leave brand/edited.mjs (changed)');
  assert.equal(lines[3], 'Would leave brand/unknown.txt (unknown)');
  assert.equal(lines[4], 'Would leave brand/state.json (unreadable: EACCES)');
  assert.equal(lines.length, 6);
});

test('dry run groups purge-only files in one sorted line', () => {
  const plan = {
    rows: [
      { kind: 'file', id: 'state', relative: 'state/run.json', action: 'keep', reason: 'purge-only' },
      { kind: 'file', id: 'config', relative: 'config.json', action: 'keep', reason: 'purge-only' },
    ],
    record: { operation: 'none', reason: 'missing' },
    directories: [],
  };
  const expected = 'Would keep 2 operator file(s) in /home/brand for --purge: config.json, state/run.json';
  assert.equal(planLines(plan, { host })[0], expected);
  assert.equal(planLines(plan, { host }).length, 2);
});

test('dry run renders each record operation without claiming execution', () => {
  const deleted = { rows: [], record: { operation: 'delete', reason: 'last owner' }, directories: [] };
  const detached = { rows: [], record: { operation: 'remove-current-owner', reason: 'other-owners' }, directories: [] };
  const kept = { rows: [], record: { operation: 'retain', reason: 'corrupt record' }, directories: [] };
  const missing = { rows: [], record: { operation: 'none', reason: 'missing' }, directories: [] };
  assert.equal(planLines(deleted, { host })[0], 'Would remove the installation record of /home/brand.');
  const detachedLine = 'Would remove /home/host from the installation record of /home/brand; the shared image stays.';
  assert.equal(planLines(detached, { host })[0], detachedLine);
  assert.equal(planLines(kept, { host })[0], 'Would keep the installation record of /home/brand (corrupt record)');
  assert.equal(planLines(missing, { host }).length, 1);
});

test('run artifacts are always last, including empty outcomes and empty plans', (t) => {
  const previous = process.env.CODEX_RUNS_ROOT;
  process.env.CODEX_RUNS_ROOT = '/outside/removal/runs';
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_RUNS_ROOT;
    else process.env.CODEX_RUNS_ROOT = previous;
  });
  const expected = 'Run artifacts in /outside/removal/runs are outside uninstall and stay.';
  const outcomes = [{ kind: 'file', id: 'install-image', relative: 'cli.mjs', result: 'removed', reason: 'last owner' }];
  const plan = { rows: [], record: { operation: 'none', reason: 'missing' }, directories: [] };
  assert.equal(outcomeLines(outcomes, { host }).at(-1), expected);
  assert.deepEqual(outcomeLines([], { host }), [expected]);
  assert.equal(planLines(plan, { host }).at(-1), expected);
  assert.equal(outcomeExitCode([]), 0);
});

test('message groups stay ordered even when file outcomes arrive in a different order', () => {
  const outcomes = [
    { kind: 'file', id: 'install-image', relative: 'failed.mjs', result: 'failed', reason: 'EPERM' },
    { kind: 'file', id: 'state', relative: 'state.json', result: 'kept', reason: 'purge-only' },
    { kind: 'file', id: null, relative: 'unknown.txt', result: 'kept', reason: 'unknown' },
    { kind: 'file', id: 'config', relative: 'config.json', result: 'removed', reason: 'purge' },
    { kind: 'file', id: 'install-image', relative: 'cli.mjs', result: 'removed', reason: 'last owner' },
    { kind: 'record', id: 'install-record', relative: '.installed.json', result: 'removed', reason: 'last owner' },
    { kind: 'directory', id: null, relative: 'lib/runner', result: 'kept', reason: 'link at lib/runner' },
    { kind: 'directory', id: null, relative: '', result: 'removed', reason: 'image' },
  ];
  const expected = [
    'Removed 1 image file(s) from /home/brand.',
    'Removed 1 data file(s) from /home/brand.',
    'Left brand/unknown.txt (unknown)',
    'Kept 1 operator file(s) in /home/brand for --purge: state.json',
    'Could not remove brand/failed.mjs: EPERM',
    'Removed the installation record of /home/brand.',
    'Left brand/lib/runner/ (link at lib/runner)',
    'Removed /home/brand.',
  ];
  assert.deepEqual(outcomeLines(outcomes, { host }).slice(0, -1), expected);
});

// D12 item 4 makes unsafe keeps nonzero for dry runs as well as real removal.
test('plan exit codes distinguish blocked plans and unsafe keeps from clean plans', () => {
  assert.equal(planExitCode({ blocked: true, rows: [] }), 1);
  for (const action of ['keep', 'blocked']) {
    for (const reason of ['link', 'link at lib/runner', 'unreadable: EACCES']) {
      assert.equal(planExitCode({ blocked: false, rows: [{ action, reason }] }), 1);
    }
  }
  const clean = { blocked: false, rows: [
    { action: 'remove', reason: 'evidence: recorded' },
    { action: 'keep', reason: 'changed' },
    { action: 'keep', reason: 'other-owners' },
    { action: 'keep', reason: 'purge-only' },
    { action: 'keep', reason: 'unknown' },
  ] };
  assert.equal(planExitCode(clean), 0);
  assert.equal(planExitCode({ blocked: false, rows: [] }), 0);
});

test('dry run keeps a detachment-dependent record when hooks cannot be removed', () => {
  const expected = 'Would keep /home/host in the installation record because its hooks could not be removed.';
  for (const operation of ['delete', 'remove-current-owner']) {
    const plan = { rows: [], record: { operation, dependsOnDetach: true }, directories: [] };
    assert.equal(planLines(plan, { host, detached: false })[0], expected);
    assert.notEqual(planLines(plan, { host })[0], expected);
    assert.notEqual(planLines(plan, { host, detached: true })[0], expected);
  }
  const independent = { rows: [], record: { operation: 'delete', dependsOnDetach: false }, directories: [] };
  assert.equal(planLines(independent, { host, detached: false })[0],
    'Would remove the installation record of /home/brand.');
});
