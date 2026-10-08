/** Shared run-store fixtures for the runs move tests: a byte snapshot and a legacy store with an empty folder. */
import fs from 'node:fs';
import path from 'node:path';

export function snapshot(root) {
  const result = {};
  function walk(relative) {
    for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
      const child = path.join(relative, name);
      const file = path.join(root, child);
      if (fs.lstatSync(file).isDirectory()) {
        result[child] = 'directory';
        walk(child);
      } else result[child] = fs.readFileSync(file).toString('hex');
    }
  }
  walk('');
  return result;
}

export function fixture(root) {
  const legacyRoot = path.join(root, '.claude', 'codex-runs');
  const homeRoot = path.join(root, 'home', 'runs');
  fs.mkdirSync(path.join(legacyRoot, 'project', 'empty'), { recursive: true });
  fs.writeFileSync(path.join(legacyRoot, 'project', 'events.jsonl'), Buffer.from([0, 10, 255]));
  fs.writeFileSync(path.join(legacyRoot, '.project.json'), '{}');
  return { root: legacyRoot, source: 'legacy', legacyRoot, homeRoot, stateDir: path.join(root, 'home', 'state') };
}
