/**
 * Reads the open-work register into source-located items and queue entries without judging them.
 * Plan_72: 15 of 20 handoff records dropped unfinished items because open work had no single home.
 */
import fs from 'node:fs';

export function parseRegister(text) {
  const items = [];
  const queue = [];
  let item = null;
  let field = null;
  let inQueue = false;

  for (const [index, textLine] of text.split(/\r?\n/).entries()) {
    const line = index + 1;
    const heading = textLine.match(/^### (OW-\d{3,}) — (.+)$/);
    if (/^#{1,6}\s/.test(textLine)) {
      item = null;
      field = null;
      if (/^#{1,2}\s/.test(textLine)) {
        // The real D1 register labels its queue with a parenthetical explanation.
        inQueue = /^## Очередь(?:\s+\(.*\))?\s*$/.test(textLine);
      }
      if (heading) {
        item = { id: heading[1], title: heading[2], line, fields: [] };
        items.push(item);
      }
      continue;
    }

    if (inQueue) {
      const entry = textLine.match(/^\d+\. (OW-\d{3,})(?=\s|$)/);
      if (entry) queue.push({ id: entry[1], line });
    }
    if (!item) continue;

    const match = textLine.match(/^- ([^:]+):\s*(.*)$/);
    if (match) {
      field = { key: match[1], value: match[2], line, valueLines: [{ value: match[2], line }] };
      item.fields.push(field);
    } else if (field && /^ {2}/.test(textLine)) {
      const value = textLine.slice(2);
      field.value += `\n${value}`;
      field.valueLines.push({ value, line });
    } else {
      field = null;
      // Blank lines may separate fields; other prose ends the item's field block.
      if (textLine.trim()) item = null;
    }
  }
  return { items, queue };
}

export function readRegister(file) {
  return parseRegister(fs.readFileSync(file, 'utf8'));
}
