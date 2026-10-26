/** OW-075 A3a: callers choose the action by cause and every migrated refusal ends in one row. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { die, RunnerUsageError, withActionRow } from '../../src/home/lib/runner/args.mjs';
import { EXIT } from '../../src/home/lib/runner/exit-codes.mjs';
import { orderDiagnosticMessage } from '../../src/home/lib/order-diagnostics.mjs';

const action = orderDiagnosticMessage('next-action', { variant: 'usage' });

test('withActionRow appends the expected row as the last line', () => {
  for (const ending of ['', '\n', '\n\n', '\r\n']) {
    assert.equal(withActionRow(`refusal${ending}`, 'usage'), `refusal\n${action}`);
  }
  assert.equal(withActionRow('', 'usage'), action);
});

test('withActionRow relocates one matching row and preserves the other lines', () => {
  assert.equal(withActionRow(`refusal\n${action}\nheader help\nquota row`, 'usage'),
    `refusal\nheader help\nquota row\n${action}`);
  assert.equal(withActionRow(`refusal\n${action}`, 'usage'), `refusal\n${action}`);
  assert.equal(withActionRow(action, 'usage'), action);
  assert.equal(withActionRow(`refusal\r\n${action}\r\nhelp\r\n`, 'usage'), `refusal\nhelp\n${action}`);
});

test('withActionRow rejects duplicate or conflicting standalone rows', () => {
  const other = orderDiagnosticMessage('next-action', { variant: 'runner-fault' });
  for (const text of [`${action}\n${action}`, `${action}\n${other}`, other]) {
    assert.throws(() => withActionRow(text, 'usage'), {
      name: 'Error', message: 'refusal carries a conflicting Action row',
    });
  }
});

test('withActionRow preserves inline Action text without counting it as a row', () => {
  const text = 'refusal with inline Action: explanation\n Action: indented text\nAction:without a space';
  assert.equal(withActionRow(text, 'usage'), `${text}\n${action}`);
});

test('withActionRow leaves unknown variant rejection to the diagnostic', () => {
  for (const variant of [undefined, 'unknown']) {
    assert.throws(() => withActionRow('refusal', variant), {
      message: `unknown next-action variant: ${variant}`,
    });
  }
});

test('die object form prints and throws the full message with exactly one final Action row', (t) => {
  const printed = t.mock.method(console, 'error', () => {});
  const message = orderDiagnosticMessage('agent-required');
  for (const options of [{ action: 'usage' }, { action: 'usage', exit: EXIT.FAIL }]) {
    const expected = `${message}\n${action}`;
    assert.throws(() => die(message, options), (error) => {
      assert.ok(error instanceof RunnerUsageError);
      assert.equal(error.message, expected);
      assert.equal(error.exitCode, options.exit ?? EXIT.USAGE);
      assert.deepEqual(error.message.split('\n').filter((line) => line.startsWith('Action: ')), [action]);
      assert.equal(error.message.split('\n').at(-1), action);
      return true;
    });
    assert.deepEqual(printed.mock.calls.at(-1).arguments, [`run-codex: ${expected}`]);
  }
  assert.equal(printed.mock.callCount(), 2);
});

test('die uses the caller variant independently of the exit code and relocates its row', (t) => {
  const printed = t.mock.method(console, 'error', () => {});
  const message = orderDiagnosticMessage('agent-required');
  const row = orderDiagnosticMessage('next-action', { variant: 'runner-fault' });
  const expected = `${message}\n${row}`;
  assert.throws(() => die(`${row}\n${message}`, { action: 'runner-fault', exit: EXIT.USAGE }), {
    name: 'Error', message: expected, exitCode: EXIT.USAGE,
  });
  assert.deepEqual(printed.mock.calls[0].arguments, [`run-codex: ${expected}`]);
});

test('die requires an action in object form before printing', (t) => {
  const printed = t.mock.method(console, 'error', () => {});
  for (const options of [{}, { exit: EXIT.FAIL }, { action: undefined }]) {
    assert.throws(() => die(orderDiagnosticMessage('agent-required'), options), {
      name: 'Error', message: 'die() needs a next-action variant',
    });
  }
  assert.equal(printed.mock.callCount(), 0);
});

test('die numeric and omitted forms retain their exit codes and add no Action row', (t) => {
  const printed = t.mock.method(console, 'error', () => {});
  const message = orderDiagnosticMessage('agent-required');
  for (const exit of [EXIT.FAIL, EXIT.USAGE, EXIT.OK, undefined]) {
    assert.throws(() => die(message, exit), (error) => {
      assert.ok(error instanceof RunnerUsageError);
      assert.equal(error.message, message);
      assert.equal(error.exitCode, exit ?? EXIT.USAGE);
      assert.doesNotMatch(error.message, /^Action: /m);
      return true;
    });
    assert.deepEqual(printed.mock.calls.at(-1).arguments, [`run-codex: ${message}`]);
  }
  assert.equal(printed.mock.callCount(), 4);
});

test('die rejects conflicting rows and unknown variants before printing', (t) => {
  const printed = t.mock.method(console, 'error', () => {});
  assert.throws(() => die(`${action}\n${action}`, { action: 'usage' }), {
    message: 'refusal carries a conflicting Action row',
  });
  assert.throws(() => die(orderDiagnosticMessage('agent-required'), { action: 'unknown' }), {
    message: 'unknown next-action variant: unknown',
  });
  assert.equal(printed.mock.callCount(), 0);
});

test('die with no second argument preserves the legacy message and default exit', (t) => {
  const printed = t.mock.method(console, 'error', () => {});
  const message = orderDiagnosticMessage('agent-required');
  assert.throws(() => die(message), { name: 'Error', message, exitCode: EXIT.USAGE });
  assert.deepEqual(printed.mock.calls[0].arguments, [`run-codex: ${message}`]);
});
