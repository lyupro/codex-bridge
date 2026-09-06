/** Verifies live catalogue rendering and refusal without executing Codex (Plan_56 step 2). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { model } from '../../cli/model.mjs';
import { fetchCatalogue } from '../../cli/model-catalogue.mjs';

function entry(overrides = {}) {
  return {
    slug: randomUUID(),
    supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
    default_reasoning_level: 'high',
    additional_speed_tiers: [],
    visibility: 'list',
    ...overrides,
  };
}

const json = (...models) => JSON.stringify({ models });
const list = (fetch, options = {}) => model(['list'], { ...options, fetchCatalogue: fetch });

test('model list includes hidden models and reports levels, defaults and faster tiers', async (t) => {
  const visible = entry();
  const hidden = entry({ visibility: 'hide', additional_speed_tiers: ['fast'], supported_in_api: false });
  const unlisted = entry({ visibility: 'none' });
  const log = t.mock.method(console, 'log', () => {});
  const result = await list(async () => json(visible, hidden, unlisted), { terminalWidth: 40 });

  assert.equal(result.exitCode, 0);
  const rows = result.output.split('\n');
  assert.equal(rows.length, 4, 'every catalogue entry is retained');
  assert.match(rows[0], /^slug\s+reasoning levels\s+default level\s+fast tier\s+visibility$/);
  assert.ok(rows[1].startsWith(visible.slug));
  assert.match(rows[1], /low, high\s+high\s+no\s+listed$/);
  assert.ok(rows[2].startsWith(hidden.slug));
  assert.match(rows[2], /low, high\s+high\s+yes \(fast\)\s+hidden \(hide\)$/);
  assert.ok(rows[3].startsWith(unlisted.slug));
  assert.match(rows[3], /hidden \(none\)$/);
  assert.equal(log.mock.callCount(), 0);
});

test('model list reflects catalogue-defined reasoning levels and service tiers', async () => {
  const custom = entry({
    supported_reasoning_levels: [{ effort: 'future-depth' }],
    default_reasoning_level: 'future-depth',
    service_tiers: [{ id: 'default' }, { id: 'priority' }],
  });
  const result = await list(() => json(custom));
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /future-depth\s+future-depth\s+yes \(priority\)/);
});

test('a catalogue failure refuses with its cause and no invented list', async () => {
  const result = await list(() => { throw new Error('authentication expired'); });
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /live catalogue unavailable; refusing to list models: authentication expired/);
  assert.doesNotMatch(result.output, /slug\s+reasoning levels|package default/);
});

test('each list fetches again and a later failure cannot reuse an earlier catalogue', async () => {
  const first = entry();
  const second = entry();
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    if (calls === 3) throw new Error('server unavailable');
    return json(calls === 1 ? first : second);
  };
  const outputs = [await list(fetch), await list(fetch), await list(fetch)];
  assert.equal(calls, 3);
  assert.ok(outputs[0].output.includes(first.slug));
  assert.ok(outputs[1].output.includes(second.slug));
  assert.ok(!outputs[1].output.includes(first.slug));
  assert.equal(outputs[2].exitCode, 1);
  assert.match(outputs[2].output, /server unavailable/);
  assert.ok(!outputs[2].output.includes(first.slug));
  assert.ok(!outputs[2].output.includes(second.slug));
});

test('invalid JSON and invalid metadata refuse the entire catalogue', async () => {
  const valid = entry();
  const cases = [
    ['{broken', /cannot parse codex debug models/],
    ['null', /models must be an array/],
    ['{}', /models must be an array/],
    [json(valid, entry({ slug: '' })), /models\[1\]\.slug/],
    [json(entry({ supported_reasoning_levels: null })), /supported_reasoning_levels must be an array/],
    [json(entry({ supported_reasoning_levels: ['low'] })), /effort must be a non-empty string/],
    [json(entry({ default_reasoning_level: 1 })), /default_reasoning_level/],
    [json(entry({ visibility: 'unexpected' })), /visibility is unknown/],
    [json(entry({ additional_speed_tiers: null })), /additional_speed_tiers must be an array/],
    [json(entry({ service_tiers: [null] })), /service_tiers\[0\]\.id/],
  ];
  for (const [payload, cause] of cases) {
    const result = await list(() => payload);
    assert.equal(result.exitCode, 1, payload);
    assert.match(result.output, /refusing to list models/);
    assert.match(result.output, cause);
    assert.ok(!result.output.includes(valid.slug), 'no partial successful listing');
  }
});

test('absent reasoning defaults are reported without inventing an effort', async () => {
  for (const defaultLevel of [null, undefined]) {
    const result = await list(() => json(entry({
      supported_reasoning_levels: [], default_reasoning_level: defaultLevel,
    })));
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /not specified\s+not specified\s+no/);
  }
});

test('an empty live catalogue is reported without substituting profiles', async () => {
  const result = await list(() => json());
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /No models returned by the live catalogue\./);
  assert.equal(result.output.split('\n').length, 2);
});

test('listing the catalogue does not require reading a profile', async () => {
  const result = await list(() => json(entry()), { configPath: { invalid: true } });
  assert.equal(result.exitCode, 0);
});

test('the catalogue transport runs the live command on each call with bounded output and time', () => {
  const payload = json(entry());
  const calls = [];
  const run = (...args) => {
    calls.push(args);
    return { status: 0, stdout: payload, stderr: '' };
  };
  assert.equal(fetchCatalogue({ run }), payload);
  assert.equal(fetchCatalogue({ run }), payload);
  assert.equal(calls.length, 2);
  for (const [command, args, options] of calls) {
    assert.equal(command, process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : 'codex');
    assert.deepEqual(args, process.platform === 'win32'
      ? ['/d', '/s', '/c', 'codex debug models'] : ['debug', 'models']);
    assert.equal(options.encoding, 'utf8');
    assert.equal(options.windowsHide, true);
    assert.ok(options.timeout > 0 && options.timeout <= 60_000);
    assert.ok(options.maxBuffer >= 1024 * 1024);
  }
});

test('transport errors, exit failures and signals refuse even with usable stdout', async () => {
  const available = entry();
  const stdout = json(available);
  const cases = [
    [{ error: Object.assign(new Error('executable missing'), { code: 'ENOENT' }), status: null }, /ENOENT.*executable missing/],
    [{ error: Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' }), status: null }, /ETIMEDOUT.*timed out/],
    [{ status: 1, stderr: 'server refused credentials' }, /server refused credentials.*exit code 1/],
    [{ status: 9, stderr: '' }, /exit code 9/],
    [{ status: null, signal: 'SIGTERM' }, /signal SIGTERM/],
    [{ status: 0, stderr: 'ERROR failed to refresh available models: authentication expired' },
      /failed to refresh available models: authentication expired/],
  ];
  for (const [response, cause] of cases) {
    const result = await list(() => fetchCatalogue({ run: () => ({ stdout, ...response }) }));
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /codex debug models failed/);
    assert.match(result.output, cause);
    assert.ok(!result.output.includes(available.slug));
  }
});
