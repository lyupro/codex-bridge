/** Prints detailed package guidance from the installed brand home. */
import fs from 'node:fs';
import path from 'node:path';
import { resolveBrandHome } from '../src/home/lib/brand-home.mjs';

export const GUIDANCE_TOPICS = Object.freeze({
  order: 'Task file, header labels, and scope.',
  advisor: 'Scope and advise phases, and the continue grant.',
  budget: 'Run deadline and slicing.',
  records: 'Finding and reading runs.',
  concurrency: 'Parallel and writing runs.',
});

const topicList = () => [
  'Topics:',
  ...Object.entries(GUIDANCE_TOPICS).map(([topic, summary]) => `  ${topic} — ${summary}`),
  '',
  'Usage: codex-bridge guidance [<topic>]',
].join('\n');

export function guidance(argv, { env = process.env, homedir } = {}) {
  if (argv.length === 0) return { exitCode: 0, output: topicList() };
  if (argv.length > 1) {
    return { exitCode: 2, output: `codex-bridge guidance accepts at most one topic.\n${topicList()}` };
  }
  const [topic] = argv;
  if (!Object.hasOwn(GUIDANCE_TOPICS, topic)) {
    return { exitCode: 2, output: `Unknown guidance topic "${topic}".\n${topicList()}` };
  }

  // The 2026-08-26 seeded-config incident forbids reading installed files from the clone.
  const { root } = resolveBrandHome({ homedir, env });
  const file = path.join(root, 'guidance', `${topic}.md`);
  try {
    return { exitCode: 0, output: fs.readFileSync(file, 'utf8') };
  } catch (error) {
    return {
      exitCode: 1,
      output: `Cannot read guidance file ${file}: ${error.message}\nrun codex-bridge update`,
    };
  }
}
