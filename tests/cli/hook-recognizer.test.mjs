/** Verifies exact recognition of this package's hook commands and host paths (Plan_65 D10). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { HOOK_DEFINITIONS } from '../../cli/manifest.mjs';
import { resolveHost } from '../../cli/hosts.mjs';
import { findOwnHooks, isOwnHookCommand } from '../../cli/hook-recognizer.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

const [FIRST] = HOOK_DEFINITIONS;
const WITNESS = HOOK_DEFINITIONS.find(({ name }) => name === 'worktree-witness');

function makeHost(t) {
  const root = makeTempTree('hook-recognizer-');
  t.after(() => removeTempTree(root));
  return resolveHost({ host: path.join(root, 'host'), brandRoot: path.join(root, 'brand') });
}

const pathCommand = (file) => `node "${path.resolve(file)}"`;
const own = (name, form) => ({ own: true, name, form });
const FOREIGN = { own: false };

test('every defined short hook command is recognized', (t) => {
  const host = makeHost(t);

  for (const { name } of HOOK_DEFINITIONS) {
    assert.deepEqual(isOwnHookCommand(`codex-bridge hook ${name}`, host), own(name, 'short'));
  }
});

test('unknown, extended, and embedded short commands are foreign', (t) => {
  const host = makeHost(t);

  assert.deepEqual(isOwnHookCommand('codex-bridge hook unknown-hook', host), FOREIGN);
  assert.deepEqual(isOwnHookCommand('codex-bridge hook reply-guard --x', host), FOREIGN);
  assert.deepEqual(isOwnHookCommand('codex-bridge hook reply-guard\n', host), FOREIGN);
  assert.deepEqual(isOwnHookCommand('echo codex-bridge hook reply-guard', host), FOREIGN);
});

test('brand hook paths are recognized in every normalized spelling', (t) => {
  const host = makeHost(t);
  const file = path.join(host.brandHooksDir, FIRST.file);

  assert.deepEqual(isOwnHookCommand(pathCommand(file), host), own(FIRST.name, 'path'));
  assert.deepEqual(isOwnHookCommand(pathCommand(file.replaceAll('\\', '/')), host), own(FIRST.name, 'path'));
  const upper = isOwnHookCommand(pathCommand(file.toUpperCase()), host);
  assert.equal(upper.own, process.platform === 'win32');
});

test('a file serving several hooks is named by its event, and unnamed without one', (t) => {
  const host = makeHost(t);
  const command = pathCommand(path.join(host.brandHooksDir, 'dispatcher-gate.mjs'));

  assert.deepEqual(isOwnHookCommand(command, host, 'PreToolUse'), own('dispatcher-gate', 'path'));
  assert.deepEqual(isOwnHookCommand(command, host, 'PostToolUseFailure'), own('dispatcher-capture-failure', 'path'));
  assert.deepEqual(isOwnHookCommand(command, host), own(null, 'path'));
});

test('the pre-brand-home agents/codex/hooks location is recognized', (t) => {
  const host = makeHost(t);
  const file = path.join(host.root, 'agents', 'codex', 'hooks', FIRST.file);

  assert.deepEqual(isOwnHookCommand(pathCommand(file), host), own(FIRST.name, 'path'));
});

test('locations and files no release installed are foreign', (t) => {
  const host = makeHost(t);
  const neverHooks = path.join(host.root, 'agents', 'codex-bridge', 'hooks', FIRST.file);
  const notOurFile = path.join(host.root, 'agents', 'codex', 'hooks', 'codex-reply-guard.mjs');
  const foreignDir = path.join(path.dirname(host.root), 'foreign-hooks', FIRST.file);

  assert.deepEqual(isOwnHookCommand(pathCommand(neverHooks), host), FOREIGN);
  assert.deepEqual(isOwnHookCommand(pathCommand(notOurFile), host), FOREIGN);
  assert.deepEqual(isOwnHookCommand(pathCommand(foreignDir), host), FOREIGN);
});

test('another interpreter or a relative path is foreign', (t) => {
  const host = makeHost(t);
  const file = path.join(host.brandHooksDir, FIRST.file);

  assert.deepEqual(isOwnHookCommand(`python "${file}"`, host), FOREIGN);
  assert.deepEqual(isOwnHookCommand(`node "hooks/${FIRST.file}"`, host), FOREIGN);
});

test('findOwnHooks returns own commands across events and groups only', (t) => {
  const host = makeHost(t);
  const shortCommand = `codex-bridge hook ${FIRST.name}`;
  const pathHookCommand = pathCommand(path.join(host.brandHooksDir, WITNESS.file));
  const settings = {
    hooks: {
      PreToolUse: [{
        matcher: 'Bash',
        hooks: [
          { type: 'command', command: shortCommand },
          { type: 'command', command: 'echo codex-bridge hook reply-guard' },
        ],
      }],
      [WITNESS.event]: [
        { matcher: 'foreign', hooks: [] },
        { matcher: '*', hooks: [{ type: 'command', command: pathHookCommand }] },
      ],
    },
  };

  assert.deepEqual(findOwnHooks(settings, host), [
    { event: 'PreToolUse', groupIndex: 0, hookIndex: 0, matcher: 'Bash', command: shortCommand, name: FIRST.name, form: 'short' },
    { event: WITNESS.event, groupIndex: 1, hookIndex: 0, matcher: '*', command: pathHookCommand, name: WITNESS.name, form: 'path' },
  ]);
});

test('findOwnHooks treats missing or malformed hooks as empty and rejects unreadable settings', (t) => {
  const host = makeHost(t);

  assert.deepEqual(findOwnHooks({}, host), []);
  assert.deepEqual(findOwnHooks({ hooks: null }, host), []);
  assert.throws(() => findOwnHooks(null, host), TypeError);
});
