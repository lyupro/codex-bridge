/**
 * Host fixtures shared by the doctor test files.
 *
 * Split out when tests/cli/doctor.test.mjs crossed the 400-line gate: the runtime checks
 * (retention, working runs) are a separate responsibility from installation and file integrity,
 * but both need the same installed host. Copying the fixture into the second file would let the
 * two drift, which is the failure the fixture itself guards against.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveHost } from '../../cli/hosts.mjs';
import { HOOK_DEFINITIONS, recordTarget, writeInstallRecord } from '../../cli/manifest.mjs';

export const ownPackage = { name: '@lyupro/codex-bridge', version: '0.1.0' };
export const codexProbe = () => ({ available: true, value: 'codex-cli 1.2.3' });

export async function hostFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-doctor-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return resolveHost({
    host: root,
    codexHome: path.join(root, 'codex-home'),
    brandRoot: path.join(root, 'brand'),
  });
}

export async function installedFixture(t) {
  const host = await hostFixture(t);
  const files = [
    { root: 'claude', path: 'agents/codex/run-codex.mjs' },
    { root: 'claude', path: 'agents/codex/required-inputs.mjs' },
    ...HOOK_DEFINITIONS.map(({ file }) => ({ root: 'brand', path: `hooks/${file}` })),
  ];
  for (const file of files) {
    const target = recordTarget(host, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.path);
  }
  const record = {
    ...ownPackage,
    installedAt: '2026-08-02T10:00:00.000Z',
    mode: 'copy',
    files,
    hooks: [
      ...HOOK_DEFINITIONS.map(({ event, file }) => ({
        event,
        root: 'brand',
        path: `hooks/${file}`,
        command: `node "${path.join(host.brandRoot, 'hooks', file)}"`,
        form: 'path',
      })),
    ],
  };
  await writeInstallRecord(host, record);
  // Registered from the definitions, not from literals: doctor compares the matcher it finds
  // against the one the installer would write, so a fixture with its own copy would report a
  // healthy host green while the real one drifted.
  const hooks = {};
  for (const definition of HOOK_DEFINITIONS) {
    const recorded = record.hooks.find((hook) => path.basename(hook.path) === definition.file);
    hooks[definition.event] ??= [];
    hooks[definition.event].push({
      matcher: definition.matcher,
      hooks: [{ type: 'command', command: recorded.command }],
    });
  }
  await fs.writeFile(host.settingsPath, JSON.stringify({ hooks }));
  return { host, record };
}

export async function runsRootFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-runs-'));
  const previous = process.env.CODEX_RUNS_ROOT;
  process.env.CODEX_RUNS_ROOT = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.CODEX_RUNS_ROOT;
    else process.env.CODEX_RUNS_ROOT = previous;
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}
