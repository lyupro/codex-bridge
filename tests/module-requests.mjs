/** Parses static module requests without linking or evaluating repository code. */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

function requests(source, file) {
  const parsed = new vm.SourceTextModule(source, { identifier: file });
  if (!Array.isArray(parsed.moduleRequests)) {
    throw new Error(`vm.SourceTextModule.moduleRequests is unavailable while parsing ${file}`);
  }
  return parsed.moduleRequests.map((request) => {
    if (typeof request.specifier !== 'string') throw new Error(`Invalid module request in ${file}`);
    return request.specifier;
  });
}

const { root, files, sources } = JSON.parse(fs.readFileSync(0, 'utf8'));
const graph = {};
const queue = [...files];
for (let index = 0; index < queue.length; index += 1) {
  const file = queue[index];
  if (Object.hasOwn(graph, file)) continue;
  const absolute = path.resolve(root, file);
  const relative = path.relative(root, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Module escapes the repository: ${file}`);
  }
  if (!fs.statSync(absolute).isFile()) throw new Error(`Module target is not a file: ${file}`);
  graph[file] = file.endsWith('.mjs') ? requests(fs.readFileSync(absolute, 'utf8'), file) : [];
  for (const specifier of graph[file]) {
    if (!specifier.startsWith('.')) continue;
    queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)));
  }
}
const probes = Object.fromEntries(Object.entries(sources).map(([file, source]) => [file, requests(source, file)]));
process.stdout.write(JSON.stringify({ graph, probes }));
