import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SNAPSHOT_V2_HEADER,
  encodeSnapshot,
  decodeSnapshot,
  compareSnapshots,
} from '../../src/home/lib/meta/snapshot-format.mjs';

const hashA = 'a'.repeat(64);
const hashB = 'b'.repeat(64);
const v2 = (line) => `${SNAPSHOT_V2_HEADER}\n${line}\n`;

for (const [name, exact, lookalike] of [
  ['Cyrillic', 'файл.txt', 'fail.txt'],
  ['tab', 'a\tb.txt', 'ab.txt'],
  ['LF', 'a\nb.txt', 'a b.txt'],
  ['CR', 'a\rb.txt', 'a_b.txt'],
  ['double quote', 'a"b.txt', 'ab.txt'],
  ['backslash', 'a\\b.txt', 'a/b.txt'],
  ['leading space', ' a.txt', 'a.txt'],
  ['trailing space', 'a.txt ', 'a.txt'],
]) {
  test(`v2 preserves ${name} separately from its sanitized lookalike`, () => {
    const rows = [{ path: exact, state: '1\t0' }, { path: lookalike, state: '0\t1' }];
    const encoded = encodeSnapshot(rows);
    const decoded = decodeSnapshot(encoded);
    assert.equal(decoded.ok, true);
    assert.equal(decoded.version, 2);
    assert.equal(decoded.rows.size, 2);
    assert.equal(decoded.rows.get(exact), '1\t0');
    assert.equal(decoded.rows.get(lookalike), '0\t1');
    assert.equal(encodeSnapshot([...decoded.rows].map(([path, state]) => ({ path, state }))), encoded);
    assert.deepEqual(compareSnapshots(encoded, encodeSnapshot([{ path: exact, state: '2\t0' }, rows[1]])),
      { ok: true, changed: [exact] });
  });
}

test('encoder sorts paths without mutating rows and writes a final newline', () => {
  const rows = [{ path: 'z', state: '1\t2' }, { path: 'a', state: '-\t-' }];
  assert.equal(encodeSnapshot(rows), `${SNAPSHOT_V2_HEADER}\n-\t-\t"a"\n1\t2\t"z"\n`);
  assert.equal(rows[0].path, 'z');
});

test('header-only v2 is clean, while absent input is missing', () => {
  const clean = encodeSnapshot([]);
  assert.equal(clean, `${SNAPSHOT_V2_HEADER}\n`);
  assert.deepEqual(decodeSnapshot(clean), { ok: true, version: 2, rows: new Map() });
  assert.deepEqual(decodeSnapshot(SNAPSHOT_V2_HEADER), { ok: true, version: 2, rows: new Map() });
  assert.equal(decodeSnapshot(null).issue, 'missing');
  assert.deepEqual(compareSnapshots(clean, clean), { ok: true, changed: [] });
});

test('all allowed v2 states round trip, including uppercase sha256 hex', () => {
  const states = ['0\t0', '123\t456', '-\t-', `U\t42:${hashA}`, `U\t0:${hashB.toUpperCase()}`, 'U\tmissing'];
  const rows = states.map((state, index) => ({ path: `file${index}`, state }));
  assert.deepEqual([...decodeSnapshot(encodeSnapshot(rows)).rows.values()], states);
});

test('BOM before the header and CRLF framing preserve v2 names', () => {
  const encoded = encodeSnapshot([{ path: ' файл\r\n.txt ', state: '1\t0' }]);
  assert.deepEqual(decodeSnapshot(`\uFEFF${encoded.replaceAll('\n', '\r\n')}`), decodeSnapshot(encoded));
});

test('empty legacy text is clean, including a BOM-only file', () => {
  assert.deepEqual(decodeSnapshot(''), { ok: true, version: 1, rows: new Map() });
  assert.deepEqual(decodeSnapshot('\uFEFF'), { ok: true, version: 1, rows: new Map() });
});

test('a legacy clean tree as the old launcher wrote it ("\\n") is clean, not malformed', () => {
  // launcher.mjs wrote `${snapshot}\n`; refusing the blank row failed every build started on a clean tree.
  for (const text of ['\n', '\r\n', '1\t0\ta.md\n\n']) assert.equal(decodeSnapshot(text).ok, true, JSON.stringify(text));
  assert.deepEqual(compareSnapshots('\n', '1\t0\ta.md\n'), { ok: true, changed: ['a.md'] });
});

test('v1 comparisons keep the legacy reader\'s ordering, trimming and dropped paths', () => {
  // Expected lists are written out: changedPaths now delegates here, so comparing with it proves nothing.
  const before = '1\t0\tchanged\r\nU\t4\tnew\r\n-\t-\tbinary\r\n2\t1\tdropped\r\n1\t0\ttrimmed \r\n';
  const after = 'U\t4\tnew\n3\t0\tchanged\n-\t-\tbinary\n1\t0\ttrimmed\nU\t0\tadded\n';
  for (const [left, right, changed] of [
    [before, after, ['changed', 'added', 'dropped']],
    [after, before, ['changed', 'dropped', 'added']],
    [before, before, []],
    ['', after, ['new', 'changed', 'binary', 'trimmed', 'added']],
    [before, '', ['changed', 'new', 'binary', 'dropped', 'trimmed']],
  ]) {
    assert.deepEqual(compareSnapshots(left, right), { ok: true, changed });
  }
  assert.deepEqual(decodeSnapshot('1\t0\ta\tb \n').rows, new Map([['a\tb', '1\t0']]));
});

for (const [before, after] of [['', encodeSnapshot([])], [encodeSnapshot([]), '']]) {
  test(`mixed versions ${decodeSnapshot(before).version}/${decodeSnapshot(after).version} refuse comparison`, () => {
    const result = compareSnapshots(before, after);
    assert.equal(result.ok, false);
    assert.equal(result.issue, 'incompatible-versions');
    assert.match(result.detail, /started under another package version/);
    assert.match(result.detail, /restart/i);
  });
}

for (const state of ['U\t42', 'U\t-1:' + hashA, 'U\t1:' + hashA.slice(1), 'U\t1:' + 'g'.repeat(64),
  'U\tMissing', '1\t-', '-1\t0', '1.5\t0', '1\t0\n', '1\t0\r', '', null, 1]) {
  test(`encoder rejects invalid state ${JSON.stringify(state)}`, () => {
    assert.throws(() => encodeSnapshot([{ path: 'file', state }]), TypeError);
  });
}

test('encoder requires rows with string paths and rejects duplicate paths', () => {
  assert.throws(() => encodeSnapshot(), TypeError);
  for (const row of [null, {}, { path: 42, state: '1\t0' }]) {
    assert.throws(() => encodeSnapshot([row]), TypeError);
  }
  assert.throws(() => encodeSnapshot([{ path: 'same', state: '1\t0' }, { path: 'same', state: '2\t0' }]), TypeError);
});

for (const [name, text] of [
  ['bad state', v2('X\t0\t"file"')],
  ['legacy untracked state in v2', v2('U\t42\t"file"')],
  ['bad hash', v2(`U\t42:${'g'.repeat(64)}\t"file"`)],
  ['bad JSON', v2('1\t0\t"file')],
  ['non-string JSON number', v2('1\t0\t42')],
  ['non-string JSON null', v2('1\t0\tnull')],
  ['non-string JSON object', v2('1\t0\t{}')],
  ['duplicate path', v2('1\t0\t"file"\n2\t0\t"file"')],
  ['equivalent JSON duplicate', v2('1\t0\t"file"\n2\t0\t"\\u0066ile"')],
  ['extra field', v2('1\t0\t"file"\textra')],
  ['missing field', v2('1\t0')],
  ['blank interior row', v2('1\t0\t"file"\n\n1\t0\t"other"')],
  ['extra trailing blank row', `${SNAPSHOT_V2_HEADER}\n\n`],
  ['bad legacy row', '1\t0\tvalid\nbroken\n'],
  ['legacy leading whitespace', '1\t0\t file\n'],
  ['legacy duplicate', '1\t0\tfile\n2\t0\tfile \n'],
  ['header after first row', `1\t0\tfile\n${SNAPSHOT_V2_HEADER}\n`],
  ['unsupported header', '# codex-bridge-state-v3\n'],
  ['non-text input', undefined],
]) {
  test(`decoder rejects the whole snapshot for ${name}`, () => {
    const result = decodeSnapshot(text);
    assert.equal(result.ok, false);
    assert.equal(result.issue, 'malformed');
    assert.equal(typeof result.detail, 'string');
    assert.equal('rows' in result, false);
  });
}

test('legacy git-quoted names refuse decoding, while v2 literal quotes are exact', () => {
  assert.equal(decodeSnapshot('1\t0\t"\\321\\204.txt"\n').issue, 'legacy-quoted-name');
  const decoded = decodeSnapshot(encodeSnapshot([{ path: '"file"', state: '1\t0' }]));
  assert.equal(decoded.ok, true);
  assert.equal(decoded.rows.get('"file"'), '1\t0');
});

test('comparison carries the failing side and its decode issue', () => {
  const clean = encodeSnapshot([]);
  for (const text of [null, v2('bad'), '1\t0\t"quoted"\n']) {
    const failure = decodeSnapshot(text);
    assert.deepEqual(compareSnapshots(text, clean), { ...failure, side: 'before' });
    assert.deepEqual(compareSnapshots(clean, text), { ...failure, side: 'after' });
  }
});

test('equal-size untracked edits change when their sha256 changes', () => {
  const before = encodeSnapshot([{ path: 'file', state: `U\t42:${hashA}` }]);
  const after = encodeSnapshot([{ path: 'file', state: `U\t42:${hashB}` }]);
  assert.deepEqual(compareSnapshots(before, before), { ok: true, changed: [] });
  assert.deepEqual(compareSnapshots(before, after), { ok: true, changed: ['file'] });
});

test('vanished untracked state differs from measured states in either direction', () => {
  const missing = encodeSnapshot([{ path: 'file', state: 'U\tmissing' }]);
  for (const size of [0, 42]) {
    const measured = encodeSnapshot([{ path: 'file', state: `U\t${size}:${hashA}` }]);
    assert.deepEqual(compareSnapshots(missing, measured), { ok: true, changed: ['file'] });
    assert.deepEqual(compareSnapshots(measured, missing), { ok: true, changed: ['file'] });
  }
});

test('v2 comparison includes dropped paths, preserving after-then-before order', () => {
  const before = encodeSnapshot([{ path: 'dropped', state: '1\t0' }, { path: 'same', state: '-\t-' }]);
  const after = encodeSnapshot([{ path: 'added', state: 'U\tmissing' }, { path: 'same', state: '-\t-' }]);
  assert.deepEqual(compareSnapshots(before, after), { ok: true, changed: ['added', 'dropped'] });
});
