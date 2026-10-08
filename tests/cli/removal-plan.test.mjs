import assert from 'node:assert/strict';
import test from 'node:test';
import { planHomeFiles, planRecordOperation, planHomeDirectories, planHomeRemoval } from '../../cli/removal-plan.mjs';

const inspection = (facts = {}) => ({
  root: 'present', files: [], unknown: [], links: [], errors: [], directories: [], ...facts,
});
const plan = (facts, options = {}) => planHomeFiles({
  command: 'uninstall',
  inspection: inspection(facts),
  imageMembers: [],
  imageEvidence: new Map(),
  imagePolicy: { remove: true, reason: 'no owners' },
  ...options,
});
const rowAt = (result, relative) => result.rows.find((row) => row.relative === relative);
const image = { relative: 'src/main.mjs', id: 'install-image', role: 'primary', removal: 'install-owned' };
const record = { relative: '.installed.json', id: 'install-record', role: 'primary', removal: 'install-owned' };
const config = { relative: 'config.json', id: 'config', role: 'primary', removal: 'purge-only' };

test('a missing root has no rows and does not block either command', () => {
  assert.deepEqual(plan({ root: 'missing' }), { rows: [], blocked: false });
  assert.deepEqual(plan({ root: 'missing' }, { command: 'purge' }), { rows: [], blocked: false });
});

test('an unreadable root blocks either command without file rows', () => {
  assert.deepEqual(plan({ root: 'error' }), { rows: [], blocked: true });
  assert.deepEqual(plan({ root: 'error' }, { command: 'purge' }), { rows: [], blocked: true });
});

test('links and read errors block, while unknown files and directories stay named', () => {
  const result = plan({
    links: [{ relative: 'config.json' }, { relative: 'foreign-link' }],
    errors: [{ relative: 'conventions.md', code: 'EACCES' }, { relative: 'foreign-error', code: 'EIO' }],
    unknown: [{ relative: 'notes.txt', kind: 'file' }, { relative: 'backup', kind: 'directory' }],
  });
  assert.deepEqual(rowAt(result, 'config.json'), { ...config, action: 'blocked', reason: 'link' });
  assert.deepEqual(rowAt(result, 'foreign-link'), { relative: 'foreign-link', id: null, role: null, removal: null, action: 'blocked', reason: 'link' });
  assert.equal(rowAt(result, 'conventions.md').id, 'conventions');
  assert.equal(rowAt(result, 'conventions.md').action, 'blocked');
  assert.equal(rowAt(result, 'conventions.md').reason, 'unreadable: EACCES');
  assert.deepEqual(rowAt(result, 'foreign-error'), { relative: 'foreign-error', id: null, role: null, removal: null, action: 'blocked', reason: 'unreadable: EIO' });
  assert.deepEqual(rowAt(result, 'notes.txt'), { relative: 'notes.txt', id: null, role: null, removal: null, action: 'keep', reason: 'unknown' });
  assert.deepEqual(rowAt(result, 'backup'), { relative: 'backup', id: null, role: null, removal: null, action: 'keep', reason: 'unknown directory' });
  assert.equal(result.blocked, true);
});

test('image policy refusal keeps a primary without requiring content evidence', () => {
  const result = plan({ files: [image] }, {
    imageMembers: [image.relative],
    imagePolicy: { remove: false, reason: 'other owners' },
  });
  assert.deepEqual(rowAt(result, image.relative), { ...image, action: 'keep', reason: 'other owners' });
  assert.equal(result.blocked, false);
});

test('an image matching its evidence is removed with a prefixed evidence reason', () => {
  const result = plan({ files: [image] }, {
    imageMembers: [image.relative],
    imageEvidence: new Map([[image.relative, { verdict: 'remove', reason: 'hash matches' }]]),
  });
  assert.deepEqual(rowAt(result, image.relative), { ...image, action: 'remove', reason: 'evidence: hash matches' });
});

test('edited image content is kept even under purge', () => {
  const result = plan({ files: [image] }, {
    command: 'purge',
    imageMembers: [image.relative],
    imageEvidence: new Map([[image.relative, { verdict: 'keep', reason: 'changed' }]]),
  });
  assert.deepEqual(rowAt(result, image.relative), { ...image, action: 'keep', reason: 'changed' });
  assert.equal(result.blocked, false);
});

test('image keep verdicts preserve link and unreadable reasons without becoming blocked', () => {
  for (const reason of ['link', 'unreadable: EACCES']) {
    const result = plan({ files: [image] }, {
      imageEvidence: new Map([[image.relative, { verdict: 'keep', reason }]]),
    });
    assert.equal(rowAt(result, image.relative).action, 'keep');
    assert.equal(rowAt(result, image.relative).reason, reason);
    assert.equal(result.blocked, false);
  }
});

test('missing image evidence verdict produces a missing row', () => {
  const result = plan({ files: [image] }, {
    imageEvidence: new Map([[image.relative, { verdict: 'missing', reason: 'missing' }]]),
  });
  assert.deepEqual(rowAt(result, image.relative), { ...image, action: 'missing', reason: 'missing' });
});

test('a present image primary without required evidence fails loudly', () => {
  assert.throws(() => plan({ files: [image] }), { name: 'TypeError', message: `Missing image evidence for ${image.relative}` });
});

test('image copy temporaries follow the image policy without content evidence', () => {
  const side = { ...image, relative: 'src/.main.mjs.temporary.tmp', role: 'copy-temporary' };
  const allowed = plan({ files: [side] });
  const refused = plan({ files: [side] }, { imagePolicy: { remove: false, reason: 'other owners' } });
  assert.deepEqual(rowAt(allowed, side.relative), { ...side, action: 'remove', reason: 'no owners' });
  assert.deepEqual(rowAt(refused, side.relative), { ...side, action: 'keep', reason: 'other owners' });
});

test('the record and its atomic temporary belong to the later record operation', () => {
  const temporary = { ...record, relative: '.installed.json.temporary.tmp', role: 'atomic-temporary' };
  for (const command of ['uninstall', 'purge']) {
    const result = plan({ files: [record, temporary] }, { command });
    assert.equal(rowAt(result, record.relative), undefined);
    assert.equal(rowAt(result, temporary.relative), undefined);
    assert.equal(plan({}, { command }).rows.some((row) => row.id === 'install-record'), false);
  }
});

test('the lifecycle lock and clear queue stay in both commands', () => {
  const lock = { ...record, relative: '.installed.json.lock', role: 'lock' };
  const queue = { ...record, relative: '.installed.json.lock.clear', role: 'clear-gate' };
  for (const command of ['uninstall', 'purge']) {
    const result = plan({ files: [lock, queue] }, { command });
    assert.deepEqual(rowAt(result, lock.relative), { ...lock, action: 'keep', reason: 'lifecycle lock' });
    assert.deepEqual(rowAt(result, queue.relative), { ...queue, action: 'keep', reason: 'clear queue' });
  }
});

test('purge-only primaries and sides stay during uninstall and go during purge', () => {
  const side = { ...config, relative: 'config.json.lock', role: 'lock' };
  const kept = plan({ files: [config, side] });
  const removed = plan({ files: [config, side] }, { command: 'purge' });
  assert.deepEqual(rowAt(kept, config.relative), { ...config, action: 'keep', reason: 'purge-only' });
  assert.deepEqual(rowAt(removed, config.relative), { ...config, action: 'remove', reason: 'purge' });
  assert.deepEqual(rowAt(kept, side.relative), { ...side, action: 'keep', reason: 'purge-only' });
  assert.deepEqual(rowAt(removed, side.relative), { ...side, action: 'remove', reason: 'purge' });
});

test('protected files stay in both commands', () => {
  const protectedFile = { relative: 'protected.txt', id: 'protected-entry', role: 'primary', removal: 'protected' };
  for (const command of ['uninstall', 'purge']) {
    assert.deepEqual(rowAt(plan({ files: [protectedFile] }, { command }), protectedFile.relative), { ...protectedFile, action: 'keep', reason: 'protected' });
  }
});

test('unlisted fixed registry primaries and image members are missing with metadata', () => {
  const result = plan({}, { imageMembers: [image.relative] });
  assert.deepEqual(rowAt(result, 'config.json'), { ...config, action: 'missing', reason: 'missing' });
  assert.deepEqual(rowAt(result, image.relative), { ...image, action: 'missing', reason: 'missing' });
  assert.equal(rowAt(result, 'state/dispatcher-contract.json').id, 'dispatcher-contract');
  assert.equal(rowAt(result, 'state/dispatcher-contract.json').action, 'missing');
  assert.equal(rowAt(result, 'state/dispatchers'), undefined);
  assert.equal(rowAt(result, 'config.json.lock'), undefined);
  assert.equal(result.blocked, false);
});

test('a linked ancestor blocks expected image and registry paths instead of claiming absence', () => {
  const result = plan({ links: [{ relative: 'state' }, { relative: 'src' }] }, { imageMembers: [image.relative] });
  assert.equal(rowAt(result, image.relative).action, 'blocked');
  assert.equal(rowAt(result, image.relative).reason, 'link at src');
  assert.equal(rowAt(result, 'state/dispatcher-contract.json').action, 'blocked');
  assert.equal(rowAt(result, 'state/dispatcher-contract.json').reason, 'link at state');
  assert.equal(result.blocked, true);
});

test('an unreadable ancestor blocks expected paths', () => {
  const result = plan({ errors: [{ relative: 'src', code: 'EACCES' }] }, { imageMembers: [image.relative] });
  assert.equal(rowAt(result, image.relative).action, 'blocked');
  assert.equal(rowAt(result, image.relative).reason, 'unreadable ancestor src');
  assert.equal(result.blocked, true);
});

test('an unknown ancestor is kept and blocks expected descendants', () => {
  const result = plan({ unknown: [{ relative: 'src', kind: 'directory' }] }, { imageMembers: [image.relative] });
  assert.equal(rowAt(result, 'src').action, 'keep');
  assert.equal(rowAt(result, image.relative).action, 'blocked');
  assert.equal(rowAt(result, image.relative).reason, 'unknown ancestor src');
  assert.equal(result.blocked, true);
});

test('ancestor matching respects path segments and does not hide sibling prefixes', () => {
  const result = plan({ links: [{ relative: 'sr' }] }, { imageMembers: [image.relative] });
  assert.equal(rowAt(result, image.relative).action, 'missing');
});

test('a root listing error does not make any expected descendant missing', () => {
  const result = plan({ errors: [{ relative: '', code: 'EACCES' }] }, { imageMembers: [image.relative] });
  assert.equal(rowAt(result, image.relative).action, 'blocked');
  assert.equal(rowAt(result, 'config.json').action, 'blocked');
  assert.equal(result.rows.some((row) => row.action === 'missing'), false);
});

test('known directories count as inspected entries rather than absent files', () => {
  const result = plan({ directories: [{ relative: image.relative }] }, { imageMembers: [image.relative] });
  assert.equal(rowAt(result, image.relative), undefined);
});

test('an unknown entry at a fixed path keeps null metadata', () => {
  const result = plan({ unknown: [{ relative: 'config.json', kind: 'directory' }] });
  assert.deepEqual(rowAt(result, 'config.json'), { relative: 'config.json', id: null, role: null, removal: null, action: 'keep', reason: 'unknown directory' });
  assert.equal(result.blocked, false);
});

test('the blocked flag follows blocked rows and stays false for keep, remove, and missing', () => {
  const result = plan({ files: [config], unknown: [{ relative: 'notes.txt', kind: 'file' }] }, { command: 'purge' });
  assert.equal(result.rows.some((row) => row.action === 'keep'), true);
  assert.equal(result.rows.some((row) => row.action === 'remove'), true);
  assert.equal(result.rows.some((row) => row.action === 'missing'), true);
  assert.equal(result.blocked, false);
  assert.equal(plan({ links: [{ relative: 'foreign' }] }).blocked, true);
});

test('invalid commands fail even when the root is missing', () => {
  for (const command of ['remove', '', null, undefined]) {
    assert.throws(() => plan({ root: 'missing' }, { command }), TypeError);
  }
});

test('rows are sorted and unique, with link then error then unknown precedence', () => {
  const result = plan({
    links: [{ relative: image.relative }, { relative: image.relative }],
    errors: [{ relative: image.relative, code: 'EIO' }, { relative: 'config.json', code: 'EACCES' }],
    unknown: [{ relative: 'config.json', kind: 'file' }, { relative: 'z.txt', kind: 'file' }, { relative: 'a.txt', kind: 'file' }],
    files: [image, config, config],
  }, { imageMembers: [image.relative, image.relative, 'config.json'] });
  const relatives = result.rows.map((row) => row.relative);
  assert.deepEqual(relatives, [...relatives].sort());
  assert.equal(new Set(relatives).size, relatives.length);
  assert.equal(rowAt(result, image.relative).reason, 'link');
  assert.equal(rowAt(result, 'config.json').reason, 'unreadable: EACCES');
});

test('planning does not mutate gathered facts or policy and is repeatable', () => {
  const input = {
    command: 'purge',
    inspection: inspection({ files: [image, config] }),
    imageMembers: [image.relative],
    imageEvidence: new Map([[image.relative, { verdict: 'remove', reason: 'hash matches' }]]),
    imagePolicy: { remove: true, reason: 'purge checks passed' },
  };
  const before = structuredClone(input);
  const first = planHomeFiles(input);
  assert.deepEqual(input, before);
  assert.deepEqual(planHomeFiles(input), first);
});

test('a missing record has no operation or detach dependency in either command', () => {
  assert.deepEqual(planRecordOperation({ command: 'uninstall', recordState: 'missing' }), { operation: 'none', reason: 'no installation record', dependsOnDetach: false, blocked: false });
  assert.deepEqual(planRecordOperation({ command: 'purge', recordState: 'missing' }), { operation: 'none', reason: 'no installation record', dependsOnDetach: false, blocked: false });
});

test('a corrupt record is retained and blocks both commands even when image removal is allowed', () => {
  assert.deepEqual(planRecordOperation({ command: 'uninstall', recordState: 'corrupt', imagePolicy: { remove: true } }), { operation: 'retain', reason: 'unreadable installation record', dependsOnDetach: false, blocked: true });
  assert.deepEqual(planRecordOperation({ command: 'purge', recordState: 'corrupt', imagePolicy: { remove: true } }), { operation: 'retain', reason: 'unreadable installation record', dependsOnDetach: false, blocked: true });
});

test('purge deletes a valid record after detach regardless of the image policy or current ownership', () => {
  assert.deepEqual(planRecordOperation({ command: 'purge', recordState: 'valid', format2: { owners: { '/other': {} }, inventory: {} }, ownerKey: '/host', imagePolicy: { remove: false, reason: 'other owners' } }), { operation: 'delete', reason: 'purge', dependsOnDetach: true, blocked: false });
});

test('uninstall deletes the last-owner record after detach when image removal is allowed', () => {
  assert.deepEqual(planRecordOperation({ command: 'uninstall', recordState: 'valid', format2: { owners: { '/host': {} }, inventory: {} }, ownerKey: '/host', imagePolicy: { remove: true, reason: 'no owners' } }), { operation: 'delete', reason: 'last owner', dependsOnDetach: true, blocked: false });
  assert.deepEqual(planRecordOperation({ command: 'uninstall', recordState: 'valid', format2: { owners: {}, inventory: {} }, ownerKey: '/host', imagePolicy: { remove: true, reason: 'orphan image' } }), { operation: 'delete', reason: 'last owner', dependsOnDetach: true, blocked: false });
});

test('uninstall removes only the current owner after detach and preserves the policy reason', () => {
  assert.deepEqual(planRecordOperation({ command: 'uninstall', recordState: 'valid', format2: { owners: { '/host': {}, '/other': {} }, inventory: {} }, ownerKey: '/host', imagePolicy: { remove: false, reason: 'other owners' } }), { operation: 'remove-current-owner', reason: 'other owners', dependsOnDetach: true, blocked: false });
  assert.deepEqual(planRecordOperation({ command: 'uninstall', recordState: 'valid', format2: { owners: { '/host': {} }, inventory: {}, legacy: {} }, ownerKey: '/host', imagePolicy: { remove: false, reason: 'incomplete inventory' } }), { operation: 'remove-current-owner', reason: 'incomplete inventory', dependsOnDetach: true, blocked: false });
});

test('uninstall retains a record this host does not own without requiring detach', () => {
  assert.deepEqual(planRecordOperation({ command: 'uninstall', recordState: 'valid', format2: { owners: { '/other': {} }, inventory: {} }, ownerKey: '/host', imagePolicy: { remove: false, reason: 'other owners' } }), { operation: 'retain', reason: 'not an owner of this home', dependsOnDetach: false, blocked: false });
  assert.deepEqual(planRecordOperation({ command: 'uninstall', recordState: 'valid', format2: { owners: { '/other': {} }, inventory: {} }, ownerKey: 'toString', imagePolicy: { remove: false, reason: 'incomplete inventory' } }), { operation: 'retain', reason: 'not an owner of this home', dependsOnDetach: false, blocked: false });
});

test('uninstall retains an owner-less valid record with the orphan reason without requiring detach', () => {
  for (const ownerKey of ['/host', 'toString']) {
    const result = planRecordOperation({
      command: 'uninstall', recordState: 'valid', format2: { owners: {}, inventory: 'incomplete' },
      ownerKey, imagePolicy: { remove: false, reason: 'incomplete inventory' },
    });
    assert.deepEqual(result, {
      operation: 'retain', reason: 'no host is recorded as using it', dependsOnDetach: false, blocked: false,
    });
  }
});

test('record planning rejects unknown and missing commands and record states', () => {
  assert.throws(() => planRecordOperation({ command: 'remove', recordState: 'missing' }), { name: 'TypeError', message: 'Invalid removal command: remove' });
  assert.throws(() => planRecordOperation({ command: 'purge', recordState: 'unreadable' }), { name: 'TypeError', message: 'Invalid installation record state: unreadable' });
  assert.throws(() => planRecordOperation({ recordState: 'missing' }), TypeError);
  assert.throws(() => planRecordOperation({ command: 'uninstall' }), TypeError);
});

test('purge plans every directory as empty-only removal in inspection order with root last', () => {
  const result = planHomeDirectories({ command: 'purge', inspection: { root: 'present', directories: [{ relative: 'state/dispatchers' }, { relative: 'lib/runner' }, { relative: 'state' }, { relative: 'lib' }] }, imageMembers: [], imagePolicy: { remove: false, reason: 'other owners' } });
  assert.deepEqual(result, [{ relative: 'state/dispatchers', action: 'remove-if-empty', reason: 'purge' }, { relative: 'lib/runner', action: 'remove-if-empty', reason: 'purge' }, { relative: 'state', action: 'remove-if-empty', reason: 'purge' }, { relative: 'lib', action: 'remove-if-empty', reason: 'purge' }, { relative: '', action: 'remove-if-empty', reason: 'purge' }]);
});

test('uninstall removes image ancestors only, protecting registered folders and sibling prefixes', () => {
  const result = planHomeDirectories({ command: 'uninstall', inspection: { root: 'present', directories: [{ relative: 'state/dispatchers' }, { relative: 'state/diagnostics' }, { relative: 'lib/runner' }, { relative: 'state' }, { relative: 'lib' }, { relative: 'li' }, { relative: 'foreign' }] }, imageMembers: ['lib/runner/main.mjs', 'state/dispatchers/image.mjs', 'state/diagnostics/image.mjs'], imagePolicy: { remove: true, reason: 'last owner' } });
  assert.deepEqual(result, [{ relative: 'state/dispatchers', action: 'keep', reason: 'holds purge-only data' }, { relative: 'state/diagnostics', action: 'keep', reason: 'holds purge-only data' }, { relative: 'lib/runner', action: 'remove-if-empty', reason: 'image' }, { relative: 'state', action: 'keep', reason: 'holds purge-only data' }, { relative: 'lib', action: 'remove-if-empty', reason: 'image' }, { relative: 'li', action: 'keep', reason: 'holds purge-only data' }, { relative: 'foreign', action: 'keep', reason: 'holds purge-only data' }, { relative: '', action: 'remove-if-empty', reason: 'image' }]);
});

test('uninstall without image removal keeps all directories and root with the policy reason', () => {
  const result = planHomeDirectories({ command: 'uninstall', inspection: { root: 'present', directories: [{ relative: 'state/dispatchers' }, { relative: 'lib/runner' }, { relative: 'state' }, { relative: 'lib' }] }, imageMembers: ['lib/runner/main.mjs'], imagePolicy: { remove: false, reason: 'other owners' } });
  assert.deepEqual(result, [{ relative: 'state/dispatchers', action: 'keep', reason: 'other owners' }, { relative: 'lib/runner', action: 'keep', reason: 'other owners' }, { relative: 'state', action: 'keep', reason: 'other owners' }, { relative: 'lib', action: 'keep', reason: 'other owners' }, { relative: '', action: 'keep', reason: 'other owners' }]);
});

test('missing and unreadable roots have no directory rows even with listed directories', () => {
  assert.deepEqual(planHomeDirectories({ command: 'purge', inspection: { root: 'missing', directories: [{ relative: 'lib' }] }, imageMembers: [], imagePolicy: { remove: true } }), []);
  assert.deepEqual(planHomeDirectories({ command: 'uninstall', inspection: { root: 'error', directories: [{ relative: 'lib' }] }, imageMembers: [], imagePolicy: { remove: true } }), []);
});

test('an empty directory inspection still plans root last', () => {
  assert.deepEqual(planHomeDirectories({ command: 'uninstall', inspection: { root: 'present', directories: [] }, imageMembers: [], imagePolicy: { remove: true } }), [{ relative: '', action: 'remove-if-empty', reason: 'image' }]);
});

test('combined deletion includes unique sorted record temporaries and is pure and repeatable', () => {
  const input = {
    command: 'purge', recordState: 'valid', format2: { owners: {}, inventory: {} }, ownerKey: '/host',
    inspection: { root: 'present', files: [{ relative: '.installed.json.z.tmp', id: 'install-record', role: 'atomic-temporary', removal: 'install-owned' }, { relative: '.installed.json.a.tmp', id: 'install-record', role: 'atomic-temporary', removal: 'install-owned' }, { relative: '.installed.json.z.tmp', id: 'install-record', role: 'atomic-temporary', removal: 'install-owned' }, { relative: '.installed.json', id: 'install-record', role: 'primary', removal: 'install-owned' }], unknown: [], links: [], errors: [], directories: [{ relative: 'lib' }] },
    imageMembers: [], imageEvidence: new Map(), imagePolicy: { remove: true, reason: 'purge' },
  };
  const before = structuredClone(input);
  const result = planHomeRemoval(input);
  assert.deepEqual(result.rows.filter((row) => row.id === 'install-record'), [{ relative: '.installed.json.a.tmp', id: 'install-record', role: 'atomic-temporary', removal: 'install-owned', action: 'remove', reason: 'record deleted' }, { relative: '.installed.json.z.tmp', id: 'install-record', role: 'atomic-temporary', removal: 'install-owned', action: 'remove', reason: 'record deleted' }]);
  assert.deepEqual(result.record, { operation: 'delete', reason: 'purge', dependsOnDetach: true, blocked: false });
  assert.deepEqual(result.directories, [{ relative: 'lib', action: 'remove-if-empty', reason: 'purge' }, { relative: '', action: 'remove-if-empty', reason: 'purge' }]);
  assert.deepEqual(result.rows.map((row) => row.relative), [...new Set(result.rows.map((row) => row.relative))].sort());
  assert.equal(result.blocked, false);
  assert.deepEqual(input, before);
  assert.deepEqual(planHomeRemoval(input), result);
});

test('combined retention keeps record temporaries in use', () => {
  const result = planHomeRemoval({ command: 'uninstall', recordState: 'valid', format2: { owners: { '/other': {} }, inventory: {} }, ownerKey: '/host', inspection: { root: 'present', files: [{ relative: '.installed.json.a.tmp', id: 'install-record', role: 'atomic-temporary', removal: 'install-owned' }], unknown: [], links: [], errors: [], directories: [] }, imageMembers: [], imageEvidence: new Map(), imagePolicy: { remove: false, reason: 'other owners' } });
  assert.deepEqual(result.rows.find((row) => row.relative === '.installed.json.a.tmp'), { relative: '.installed.json.a.tmp', id: 'install-record', role: 'atomic-temporary', removal: 'install-owned', action: 'keep', reason: 'record in use' });
  assert.deepEqual(result.record, { operation: 'retain', reason: 'not an owner of this home', dependsOnDetach: false, blocked: false });
  assert.equal(result.blocked, false);
});

test('removing only the current owner also keeps record temporaries in use', () => {
  const result = planHomeRemoval({ command: 'uninstall', recordState: 'valid', format2: { owners: { '/host': {}, '/other': {} }, inventory: {} }, ownerKey: '/host', inspection: { root: 'present', files: [{ relative: '.installed.json.a.tmp', id: 'install-record', role: 'atomic-temporary', removal: 'install-owned' }], unknown: [], links: [], errors: [], directories: [] }, imageMembers: [], imageEvidence: new Map(), imagePolicy: { remove: false, reason: 'other owners' } });
  assert.deepEqual(result.rows.find((row) => row.relative === '.installed.json.a.tmp'), { relative: '.installed.json.a.tmp', id: 'install-record', role: 'atomic-temporary', removal: 'install-owned', action: 'keep', reason: 'record in use' });
  assert.equal(result.record.operation, 'remove-current-owner');
  assert.equal(result.blocked, false);
});

test('a corrupt record blocks the combined plan without any blocked file row', () => {
  const result = planHomeRemoval({ command: 'purge', recordState: 'corrupt', inspection: { root: 'present', files: [{ relative: '.installed.json.a.tmp', id: 'install-record', role: 'atomic-temporary', removal: 'install-owned' }], unknown: [], links: [], errors: [], directories: [] }, imageMembers: [], imageEvidence: new Map(), imagePolicy: { remove: true, reason: 'purge' } });
  assert.deepEqual(result.record, { operation: 'retain', reason: 'unreadable installation record', dependsOnDetach: false, blocked: true });
  assert.deepEqual(result.rows.find((row) => row.relative === '.installed.json.a.tmp'), { relative: '.installed.json.a.tmp', id: 'install-record', role: 'atomic-temporary', removal: 'install-owned', action: 'keep', reason: 'record in use' });
  assert.equal(result.rows.some((row) => row.action === 'blocked'), false);
  assert.equal(result.blocked, true);
});

test('blocked files still block the combined plan when the record does not block', () => {
  const result = planHomeRemoval({ command: 'uninstall', recordState: 'missing', inspection: { root: 'present', files: [], unknown: [], links: [{ relative: 'foreign' }], errors: [], directories: [] }, imageMembers: [], imageEvidence: new Map(), imagePolicy: { remove: false, reason: 'no record' } });
  assert.equal(result.record.blocked, false);
  assert.equal(result.rows.some((row) => row.action === 'blocked'), true);
  assert.equal(result.blocked, true);
});

test('the combined plan for a missing home and record contains no file or directory rows', () => {
  assert.deepEqual(planHomeRemoval({ command: 'uninstall', recordState: 'missing', inspection: { root: 'missing', files: [], unknown: [], links: [], errors: [], directories: [] }, imageMembers: [], imageEvidence: new Map(), imagePolicy: { remove: false, reason: 'no record' } }), { rows: [], directories: [], record: { operation: 'none', reason: 'no installation record', dependsOnDetach: false, blocked: false }, blocked: false });
});

test('the run records folder of the home is kept and named, never removed (Plan_77 D1)', () => {
  for (const command of ['uninstall', 'purge']) {
    const result = plan({ unknown: [{ relative: 'runs', kind: 'directory' }] }, { command });
    assert.deepEqual(rowAt(result, 'runs'), { relative: 'runs', id: null, role: null, removal: null, action: 'keep', reason: 'run records' });
  }
  const file = plan({ unknown: [{ relative: 'runs', kind: 'file' }] });
  assert.equal(rowAt(file, 'runs').reason, 'unknown');
});
