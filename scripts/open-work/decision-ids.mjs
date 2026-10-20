/**
 * Detects repeated decision IDs across each whole top-level plan.
 * Plan_80 E29: decisions are appended in later sections, so a section-limited scan
 * missed the real duplicate E25, making references to that ID ambiguous.
 */
import fs from 'node:fs';
import path from 'node:path';

export function checkDecisionIds(root) {
  const directory = path.join(root, 'docs/plans');
  if (!fs.existsSync(directory)) return [];
  const violations = [];
  const entries = fs.readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const entry of entries) {
    if (!entry.isFile() || !/^Plan_.*\.md$/.test(entry.name)) continue;
    const ids = new Map();
    const lines = fs.readFileSync(path.join(directory, entry.name), 'utf8').split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      const match = line.match(/^- \*\*([A-Z]{1,3}(?:-[A-Z]{1,3})?\d+[a-z]?)(?: —|\. (?!—))/);
      if (!match) continue;
      if (!ids.has(match[1])) ids.set(match[1], []);
      ids.get(match[1]).push(index + 1);
    }
    for (const [id, locations] of ids) {
      if (locations.length < 2) continue;
      violations.push(`docs/plans/${entry.name}:${locations[0]}: decision id ${id} repeats at lines ${locations.join(', ')}`);
    }
  }
  return violations;
}
