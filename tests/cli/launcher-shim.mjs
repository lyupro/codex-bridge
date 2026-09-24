import fsSync from 'node:fs';
import path from 'node:path';
import { HOOK_LAUNCHER_PROTOCOL } from '../../cli/hook.mjs';
import { makeTempTree, removeTempTree } from '../temp-tree.mjs';

export function launcherEnv(t, homeRoot) {
  const directory = makeTempTree('dispatcher-launcher-');
  t.after(() => removeTempTree(directory));
  const answer = JSON.stringify({ protocol: HOOK_LAUNCHER_PROTOCOL, dispatch: 'home', homeRoot });
  const windows = process.platform === 'win32';
  fsSync.writeFileSync(path.join(directory, windows ? 'codex-bridge.cmd' : 'codex-bridge'),
    windows ? `@echo off\r\nif "%*"=="hook --home" echo ${answer}\r\n`
      : `#!/bin/sh\nprintf '%s\\n' '${answer}'\n`, { mode: 0o755 });
  return windows ? { PATH: directory, PATHEXT: '.CMD' } : { PATH: directory };
}
