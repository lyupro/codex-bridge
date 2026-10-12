/** Plan_79 D5 checks actual refusal text in isolated children, keeping intentional violations out of the suite journal. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeTempTree } from './temp-tree.mjs';
import { inspectOutgoingRefusals } from '../scripts/run-tests.mjs';

const recorder = new URL('../src/home/lib/order-text-record.mjs', import.meta.url).href;
const args = new URL('../src/home/lib/runner/args.mjs', import.meta.url).href;
const fixture = process.env.CODEX_BRIDGE_D5_FIXTURE;

function runCase(body, { marker = true, blocked = false } = {}) {
  const tree = makeTempTree('order-text-record-');
  const root = path.join(tree, 'marker');
  if (blocked) fs.writeFileSync(root, 'not a directory');
  const env = { ...process.env, D5_ROOT: root };
  if (marker) env.CODEX_BRIDGE_TEST_TMP = root;
  else delete env.CODEX_BRIDGE_TEST_TMP;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    import { recordOrderText, checkOutgoingRefusal } from ${JSON.stringify(recorder)};
    ${body}
  `], { env, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const directory = path.join(root, 'order-text-violations');
  const lines = fs.existsSync(directory) ? fs.readdirSync(directory).flatMap((file) =>
    fs.readFileSync(path.join(directory, file), 'utf8').trim().split('\n').filter(Boolean)) : [];
  return { root, result, lines, entries: lines.map((line) => JSON.parse(line)) };
}

if (fixture) {
  // Plan_79 D5: the nested suite passes an expected refusal while its journal must still fail it.
  test('nested suite catches its expected refusal', async () => {
    const { die, RunnerUsageError } = await import(args);
    const { recordOrderText } = await import(recorder);
    const message = fixture === 'registered' ? recordOrderText('registered refusal') : 'handwritten refusal';
    assert.throws(() => die(message), RunnerUsageError);
  });
} else {
  const passes = [
    ['recorded message', 'known'],
    ['longest recorded string first', "recordOrderText('registered phrase')"],
    ['all separators and whitespace', JSON.stringify(' \t:;,.\r\n')],
    ['multi-line join', `[known, other, known].join(${JSON.stringify('\r\n: ; , .\t')})`],
    ['repeated recorded strings', 'known + known + other'],
    ['empty message', "''"],
  ];
  for (const [name, expression] of passes) {
    test(`recorded refusal accepts ${name}`, () => {
      const { entries } = runCase(`
        const known = recordOrderText('registered');
        const other = recordOrderText('other recorded text');
        assert.equal(recordOrderText(''), '');
        const outgoing = ${expression};
        assert.doesNotThrow(() => assert.equal(checkOutgoingRefusal(outgoing, 'case'), outgoing));
      `);
      assert.deepEqual(entries, []);
    });
  }

  const failures = [
    ['plain string', "'handwritten'"],
    ['ternary branch', "true ? 'handwritten' : known"],
    ['logical-or fallback', "'' || 'handwritten'"],
    ['nullish fallback', "null ?? 'handwritten'"],
    ['concat', "known.concat(' handwritten')"],
    ['recorded string plus extra text', "known + ' handwritten'"],
    ['compound assignment', "(() => { let text = known; text += ' handwritten'; return text; })()"],
    ['alias', "(() => { const alias = 'handwritten'; return alias; })()"],
    ['unapproved punctuation', "known + '!'"],
  ];
  for (const [name, expression] of failures) {
    test(`unregistered refusal journals ${name}`, () => {
      const { entries, lines } = runCase(`
        const known = recordOrderText('registered');
        const outgoing = ${expression};
        assert.doesNotThrow(() => assert.equal(checkOutgoingRefusal(outgoing, 'case'), outgoing));
      `);
      assert.equal(lines.length, 1);
      assert.equal(entries[0].transport, 'case');
      assert.match(entries[0].message, /handwritten|!/);
      assert.ok(Number.isInteger(entries[0].pid));
      assert.notEqual(entries[0].pid, process.pid);
      assert.match(entries[0].stack, /checkOutgoingRefusal/);
      assert.ok(entries[0].stack.split('\n').length <= 32);
    });
  }

  test('without the marker neither function writes or records, and both return their input', () => {
    const { entries } = runCase(`
      assert.equal(recordOrderText('not recorded'), 'not recorded');
      assert.equal(checkOutgoingRefusal('not recorded', 'absent'), 'not recorded');
      assert.equal(fs.existsSync(process.env.D5_ROOT), false);
      process.env.CODEX_BRIDGE_TEST_TMP = process.env.D5_ROOT;
      checkOutgoingRefusal('not recorded', 'enabled later');
    `, { marker: false });
    assert.equal(entries.length, 1, 'a call without the marker must not have registered its text');
    assert.equal(entries[0].transport, 'enabled later');
  });

  test('checking a refusal never throws or changes it when the journal cannot be written', () => {
    const { entries } = runCase(`
      assert.doesNotThrow(() => assert.equal(checkOutgoingRefusal('handwritten', 'blocked'), 'handwritten'));
    `, { blocked: true });
    assert.deepEqual(entries, []);
  });

  test('registry helpers and pending producers record their unchanged output', () => {
    const lib = new URL('../src/home/lib/', import.meta.url);
    const { entries } = runCase(`
      const { orderRuleMessage, orderRefusalAt } = await import(${JSON.stringify(new URL('order-rules.mjs', lib).href)});
      const { orderDiagnosticMessage } = await import(${JSON.stringify(new URL('order-diagnostics.mjs', lib).href)});
      const { orderInputName, renderOrderHeaderHelp, renderOrderProblems } = await import(${JSON.stringify(new URL('order-schema.mjs', lib).href)});
      const { parseTaskHeader, taskHeaderRefusal } = await import(${JSON.stringify(new URL('task-header.mjs', lib).href)});
      const messages = [
        orderRuleMessage('verify-line', { violation: 'empty' }),
        orderDiagnosticMessage('agent-required'),
        orderRefusalAt('location', 'refusal'),
        renderOrderHeaderHelp('codex-scout'),
        renderOrderProblems('codex-scout', [{ lineNo: null, reason: 'pending schema refusal' }]),
        taskHeaderRefusal(parseTaskHeader(${JSON.stringify('continue: . — reason\n\nTask')})),
        orderInputName('effort') + ' ' + orderRuleMessage('effort-value', { value: 'two words' }),
      ];
      assert.equal(messages[0], 'Verify section is empty');
      assert.equal(messages[1], '--agent is required');
      assert.equal(messages[2], 'location: refusal');
      for (const message of messages) assert.equal(checkOutgoingRefusal(message, 'producer'), message);
    `);
    assert.deepEqual(entries, []);
  });

  test('die journals before the expected refusal is caught, preserving text and exit code', () => {
    const { entries, result } = runCase(`
      const { die, RunnerUsageError } = await import(${JSON.stringify(args)});
      assert.throws(() => die('handwritten', 1), (error) =>
        error instanceof RunnerUsageError && error.message === 'handwritten' && error.exitCode === 1);
    `);
    assert.equal(result.stderr, 'run-codex: handwritten\n');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].transport, 'die');
    assert.equal(entries[0].message, 'handwritten');
  });

  test('refusal capture includes both callers of die and restores the host frame limit', () => {
    const { entries } = runCase(`
      const { die, RunnerUsageError } = await import(${JSON.stringify(args)});
      Error.stackTraceLimit = 1;
      function refusalCaller() { die('handwritten'); }
      function admissionCaller() { refusalCaller(); }
      assert.throws(admissionCaller, RunnerUsageError);
      assert.equal(Error.stackTraceLimit, 1);
    `);
    assert.equal(entries.length, 1);
    assert.match(entries[0].stack, /at die /);
    assert.match(entries[0].stack, /at refusalCaller /);
    assert.match(entries[0].stack, /at admissionCaller /);
    assert.match(entries[0].caller, /^at refusalCaller /);
    assert.equal(entries[0].caller, entries[0].stack.split('\n')[2].trim());
  });

  function journalCase(files, pendingMigration, { ancestor = '', omitCaller = false, caller } = {}) {
    const directory = makeTempTree('order-text-journal-');
    const entry = (file) => JSON.stringify({
      transport: 'die', message: 'handwritten refusal', pid: 1,
      ...(!omitCaller && { caller: caller ?? `    at refusalCaller (${file}:111:1)` }),
      stack: '    at checkOutgoingRefusal (file:///C:/fixture/src/home/lib/order-text-record.mjs:20:1)\n' +
        '    at die (file:///C:/fixture/src/home/lib/runner/args.mjs:31:1)\n' +
        `    at refusalCaller (${file}:111:1)` + ancestor,
    });
    // Plan_79 B3j D5: injected lists and disposable journals never mutate the live migration list.
    for (const [index, file] of files.entries()) {
      fs.writeFileSync(path.join(directory, `${index}.jsonl`), entry(file) + '\n');
    }
    const output = [];
    const fatal = inspectOutgoingRefusals(directory, pendingMigration, (line) => output.push(line));
    return { fatal, output, directory };
  }

  test('pending-file refusals are counted across journals and reported in one summary', () => {
    const pending = 'src/home/lib/runner/launcher.mjs';
    const { fatal, output } = journalCase([
      `file:///C:/fixture/${pending}`, `C:\\fixture\\${pending.replaceAll('/', '\\')}`,
    ], new Set([pending]));
    assert.equal(fatal, 0);
    assert.deepEqual(output, ['run-tests: 2 refusals from pending files tolerated until their migration\n']);
  });

  // Plan_79 B3jd D5: copied homes retain home-relative paths, not the src/home prefix.
  test('a copied home image tolerates a pending caller', () => {
    const pending = 'src/home/lib/runner/preflight.mjs';
    const { fatal, output } = journalCase([
      'file:///C:/fixture/home-image-oSACGX/lib/runner/preflight.mjs',
      'C:\\fixture\\installed-home\\lib\\runner\\preflight.mjs',
    ], new Set([pending]));
    assert.equal(fatal, 0);
    assert.deepEqual(output, ['run-tests: 2 refusals from pending files tolerated until their migration\n']);
  });

  test('a copied home image still rejects a migrated caller', () => {
    const { fatal, output } = journalCase([
      'file:///C:/fixture/home-image-oSACGX/lib/runner/task-input.mjs',
    ], new Set(['src/home/lib/runner/preflight.mjs']));
    assert.equal(fatal, 1);
    assert.equal(output.length, 1);
    assert.match(output[0], /^run-tests: refusal text outside the registry: /);
  });

  test('a copied home path must match a pending caller on a path-segment boundary', () => {
    const { fatal, output } = journalCase([
      'file:///C:/fixture/home-image-oSACGX/xlib/runner/preflight.mjs',
    ], new Set(['src/home/lib/runner/preflight.mjs']));
    assert.equal(fatal, 1);
    assert.equal(output.length, 1);
    assert.match(output[0], /^run-tests: refusal text outside the registry: /);
  });

  test('pending entries outside src/home still require their repository path', () => {
    const pending = 'scripts/preflight.mjs';
    const { fatal, output } = journalCase([
      `file:///C:/fixture/${pending}`, 'file:///C:/fixture/home-image-oSACGX/preflight.mjs',
    ], new Set([pending]));
    assert.equal(fatal, 1);
    assert.equal(output.length, 2);
    assert.match(output[0], /^run-tests: refusal text outside the registry: /);
    assert.equal(output[1], 'run-tests: 1 refusals from pending files tolerated until their migration\n');
  });

  test('an unreadable journal line remains fatal', () => {
    const pending = 'src/home/lib/runner/preflight.mjs';
    const { directory } = journalCase([], new Set([pending]));
    fs.writeFileSync(path.join(directory, 'unreadable.jsonl'), '{"caller":\n');
    const output = [];
    assert.equal(inspectOutgoingRefusals(directory, new Set([pending]), (line) => output.push(line)), 1);
    assert.deepEqual(output, ['run-tests: refusal text outside the registry: {"caller":\n']);
  });

  test('the same refusal from a migrated file remains fatal alongside pending refusals', () => {
    const pending = 'src/home/lib/runner/launcher.mjs';
    const migrated = 'src/home/lib/runner/task-input.mjs';
    const { fatal, output } = journalCase([
      `file:///C:/fixture/${pending}`, `file:///C:/fixture/${migrated}`,
    ], new Set([pending]));
    assert.equal(fatal, 1);
    assert.equal(output.length, 2);
    assert.match(output[0], /^run-tests: refusal text outside the registry: /);
    const entry = JSON.parse(output[0].slice('run-tests: refusal text outside the registry: '.length));
    assert.equal(entry.message, 'handwritten refusal');
    assert.match(entry.stack, /task-input\.mjs:111:1/);
    assert.equal(output[1], 'run-tests: 1 refusals from pending files tolerated until their migration\n');
  });

  test('a pending caller is tolerated even with migrated files elsewhere in its stack', () => {
    const pending = 'src/home/lib/runner/launcher.mjs';
    const { fatal, output } = journalCase([`file:///C:/fixture/${pending}`], new Set([pending]), {
      ancestor: '\n    at migratedCaller (file:///C:/fixture/src/home/lib/runner/task-input.mjs:96:1)',
    });
    assert.equal(fatal, 0);
    assert.deepEqual(output, ['run-tests: 1 refusals from pending files tolerated until their migration\n']);
  });

  test('a migrated caller is fatal even with a pending launcher further up its stack', () => {
    const pending = 'src/home/lib/runner/launcher.mjs';
    const { fatal, output } = journalCase(['file:///C:/fixture/src/home/lib/runner/task-input.mjs'], new Set([pending]), {
      ancestor: `\n    at launcher (file:///C:/fixture/${pending}:96:1)`,
    });
    assert.equal(fatal, 1);
    assert.equal(output.length, 1);
    assert.match(output[0], /^run-tests: refusal text outside the registry: /);
  });

  test('a journal without caller is fatal even when its stack names a pending file', () => {
    const pending = 'src/home/lib/runner/launcher.mjs';
    const { fatal, output } = journalCase([`file:///C:/fixture/${pending}`], new Set([pending]), { omitCaller: true });
    assert.equal(fatal, 1);
    assert.equal(output.length, 1);
    assert.match(output[0], /^run-tests: refusal text outside the registry: /);
  });

  for (const caller of ['', 'unreadable', 'file:///C:/fixture/src/home/lib/runner/launcher.mjs']) {
    test(`an unreadable caller ${JSON.stringify(caller)} is fatal despite a pending stack frame`, () => {
      const pending = 'src/home/lib/runner/launcher.mjs';
      const { fatal, output } = journalCase([`file:///C:/fixture/${pending}`], new Set([pending]), { caller });
      assert.equal(fatal, 1);
      assert.equal(output.length, 1);
      assert.match(output[0], /^run-tests: refusal text outside the registry: /);
    });
  }

  test('removing a file from an injected pending list makes the unchanged journal fatal', () => {
    const pending = 'src/home/lib/runner/launcher.mjs';
    const pendingMigration = new Set([pending]);
    const { directory, fatal } = journalCase([`file:///C:/fixture/${pending}`], pendingMigration);
    assert.equal(fatal, 0);
    pendingMigration.delete(pending);
    const output = [];
    assert.equal(inspectOutgoingRefusals(directory, pendingMigration, (line) => output.push(line)), 1);
    assert.equal(output.length, 1);
    assert.match(output[0], /^run-tests: refusal text outside the registry: /);
    assert.doesNotMatch(output[0], /tolerated until their migration/);
  });

  test('a longer file name cannot be mistaken for a pending file', () => {
    const pending = 'src/home/lib/runner/launcher.mjs';
    const { fatal, output } = journalCase([`file:///C:/fixture/${pending}.extra`], new Set([pending]));
    assert.equal(fatal, 1);
    assert.equal(output.length, 1);
    assert.match(output[0], /^run-tests: refusal text outside the registry: /);
  });

  for (const [kind, status] of [['registered', 0], ['unregistered', 1]]) {
    test(`suite exit status reflects ${kind} refusal text even when its test passes`, () => {
      const tree = makeTempTree('order-text-suite-');
      const env = { ...process.env, CODEX_BRIDGE_TEST_TMP: tree, CODEX_BRIDGE_D5_FIXTURE: kind };
      // Plan_79 D5: a separate suite must not inherit Node's recursive-test suppression marker.
      delete env.NODE_TEST_CONTEXT;
      const result = spawnSync(process.execPath, [
        fileURLToPath(new URL('../scripts/run-tests.mjs', import.meta.url)),
        'tests/order-text-record.test.mjs',
      ], {
        env,
        encoding: 'utf8', windowsHide: true, timeout: 20_000,
      });
      assert.ifError(result.error);
      assert.equal(result.status, status, result.stderr || result.stdout);
      assert.match(result.stdout, /pass 1/);
      assert.match(result.stdout, /fail 0/);
      if (status) {
        const lines = result.stderr.split('\n').filter((line) => line.startsWith('run-tests: refusal text outside the registry: '));
        assert.equal(lines.length, 1);
        const entry = JSON.parse(lines[0].slice('run-tests: refusal text outside the registry: '.length));
        assert.equal(entry.message, 'handwritten refusal');
        assert.equal(entry.transport, 'die');
      } else {
        assert.doesNotMatch(result.stderr, /refusal text outside the registry/);
      }
      assert.deepEqual(fs.readdirSync(tree), [], 'the nested suite cleans its own journal root');
    });
  }
}
