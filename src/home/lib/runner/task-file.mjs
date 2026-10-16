/**
 * Parses the task document without knowing how it reached the runner.
 *
 * The 2026-08-15 permission-rule incident showed that model-written questions and verification
 * commands cannot safely travel through a shell command line. Recognised sections keep that free
 * text in the file while the headingless form preserves every existing task file.
 */

import { orderRuleMessage } from '../order-rules.mjs';

const SECTION_HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*$/;
const LIST_ITEM = /^\s*(?:[-*]|\d+\.)[ \t]+(.+?)\s*$/;
const SECTION_NAMES = new Map([
  ['task', 'task'],
  ['questions', 'questions'],
  ['verify', 'verify'],
]);

/**
 * A heading, its level, and the section it opens when the runner recognises its text.
 *
 * The level is what closes a section. Treating every unrecognised heading as ordinary content
 * made the first task file written against this format unreadable: a `## Constraints` heading
 * after `## Verify` was swallowed into the verification command, and the document was refused
 * for holding more than one command. A sibling or shallower heading ends the section it follows;
 * only a deeper one belongs to it.
 */
function headingFrom(line) {
  const match = SECTION_HEADING.exec(line);
  if (!match) return undefined;
  const text = match[2].replace(/[ \t]+#+[ \t]*$/, '').trim();
  return { level: match[1].length, text, section: SECTION_NAMES.get(text.toLowerCase()) };
}

export function resumeBodyHeading(text) {
  for (const line of String(text).split(/\r?\n/)) {
    const heading = headingFrom(line);
    if (heading && ['questions', 'verify', 'options', 'paths'].includes(heading.text.toLowerCase())) {
      return heading.text;
    }
  }
  return null;
}

function sectionFrom(line) {
  return headingFrom(line)?.section;
}

export function parseTaskDocument(text) {
  const lines = String(text).split(/\r?\n/);
  const hasSections = lines.some((line) => sectionFrom(line) !== undefined);
  if (!hasSections) return { task: String(text).trim(), questions: [], verify: undefined };

  const taskLines = [];
  const questionLines = [];
  const verifyLines = [];
  let section = 'task';
  let sectionLevel = 0;
  let sawQuestions = false;
  let sawVerify = false;

  for (const line of lines) {
    const heading = headingFrom(line);
    if (heading?.section !== undefined) {
      section = heading.section;
      sectionLevel = heading.level;
      if (section === 'questions') sawQuestions = true;
      if (section === 'verify') sawVerify = true;
      continue;
    }
    // An unrecognised heading at the section's own level or above ends it; the heading itself is
    // part of the task statement from there on. A deeper heading stays inside the section.
    if (heading && section !== 'task' && heading.level <= sectionLevel) {
      section = 'task';
      sectionLevel = 0;
    }
    if (section === 'questions') questionLines.push(line);
    else if (section === 'verify') verifyLines.push(line);
    else taskLines.push(line);
  }

  const questions = [];
  for (const line of questionLines) {
    if (!line.trim()) continue;
    const item = LIST_ITEM.exec(line);
    if (!item) {
      throw new Error(orderRuleMessage('scout-questions', { violation: 'non-list-line', line }));
    }
    questions.push(item[1].trim());
  }
  if (sawQuestions && !questions.length) throw new Error(orderRuleMessage('scout-questions', { violation: 'empty' }));

  const verifyContent = verifyLines.filter((line) => line.trim());
  if (sawVerify && !verifyContent.length) throw new Error(orderRuleMessage('verify-line', { violation: 'empty' }));
  if (verifyContent.length > 1) {
    throw new Error(orderRuleMessage('verify-line', { violation: 'multiple-lines' }));
  }

  return {
    task: taskLines.join('\n').trim(),
    questions,
    verify: sawVerify ? verifyContent[0].trim() : undefined,
  };
}
