import assert from 'node:assert/strict';
import test from 'node:test';
import { planHomeFiles } from '../../cli/removal-plan.mjs';

const inspection = (facts = {}) => ({
  root: 'present', files: [], unknown: [], links: [], errors: [], directories: [], ...facts,
});
const plan = (facts, options = {}) => planHomeFiles({
  mode: 'uninstall',
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

test('a missing root has no rows and does not block either mode', () => {
  assert.deepEqual(plan({ root: 'missing' }), { rows: [], blocked: false });
  assert.deepEqual(plan({ root: 'missing' }, { mode: 'purge' }), { rows: [], blocked: false });
});

test('an unreadable root blocks either mode without file rows', () => {
  assert.deepEqual(plan({ root: 'error' }), { rows: [], blocked: true });
  assert.deepEqual(plan({ root: 'error' }, { mode: 'purge' }), { rows: [], blocked: true });
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
    mode: 'purge',
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
  for (const mode of ['uninstall', 'purge']) {
    const result = plan({ files: [record, temporary] }, { mode });
    assert.equal(rowAt(result, record.relative), undefined);
    assert.equal(rowAt(result, temporary.relative), undefined);
    assert.equal(plan({}, { mode }).rows.some((row) => row.id === 'install-record'), false);
  }
});

test('the lifecycle lock and clear queue stay in both modes', () => {
  const lock = { ...record, relative: '.installed.json.lock', role: 'lock' };
  const queue = { ...record, relative: '.installed.json.lock.clear', role: 'clear-gate' };
  for (const mode of ['uninstall', 'purge']) {
    const result = plan({ files: [lock, queue] }, { mode });
    assert.deepEqual(rowAt(result, lock.relative), { ...lock, action: 'keep', reason: 'lifecycle lock' });
    assert.deepEqual(rowAt(result, queue.relative), { ...queue, action: 'keep', reason: 'clear queue' });
  }
});

test('purge-only primaries and sides stay during uninstall and go during purge', () => {
  const side = { ...config, relative: 'config.json.lock', role: 'lock' };
  const kept = plan({ files: [config, side] });
  const removed = plan({ files: [config, side] }, { mode: 'purge' });
  assert.deepEqual(rowAt(kept, config.relative), { ...config, action: 'keep', reason: 'purge-only' });
  assert.deepEqual(rowAt(removed, config.relative), { ...config, action: 'remove', reason: 'purge' });
  assert.deepEqual(rowAt(kept, side.relative), { ...side, action: 'keep', reason: 'purge-only' });
  assert.deepEqual(rowAt(removed, side.relative), { ...side, action: 'remove', reason: 'purge' });
});

test('protected files stay in both modes', () => {
  const protectedFile = { relative: 'protected.txt', id: 'protected-entry', role: 'primary', removal: 'protected' };
  for (const mode of ['uninstall', 'purge']) {
    assert.deepEqual(rowAt(plan({ files: [protectedFile] }, { mode }), protectedFile.relative), { ...protectedFile, action: 'keep', reason: 'protected' });
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
  const result = plan({ files: [config], unknown: [{ relative: 'notes.txt', kind: 'file' }] }, { mode: 'purge' });
  assert.equal(result.rows.some((row) => row.action === 'keep'), true);
  assert.equal(result.rows.some((row) => row.action === 'remove'), true);
  assert.equal(result.rows.some((row) => row.action === 'missing'), true);
  assert.equal(result.blocked, false);
  assert.equal(plan({ links: [{ relative: 'foreign' }] }).blocked, true);
});

test('invalid modes fail even when the root is missing', () => {
  for (const mode of ['remove', '', null, undefined]) {
    assert.throws(() => plan({ root: 'missing' }, { mode }), TypeError);
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
    mode: 'purge',
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
