/**
 * Renders the reply lines a dispatcher is allowed to return, one format per agent.
 *
 * AGENTS is the registry of the three dispatchers: for each one it names the result file
 * that run writes, how to tell that file is filled in, and which of the three reply
 * strategies below renders it. FAIL and LIMIT bypass the per-agent strategy — a run that
 * produced nothing has nothing agent-specific left to say.
 *
 * The lines built here ARE the reply. Agents forward this text verbatim instead of
 * composing prose, which is what keeps a delegated run at five lines.
 */
import path from 'node:path';
import { changedPaths, line, readText } from './paths.mjs';
import { splitRunChanges } from './environment.mjs';
import { scoutCoverage } from './verdict.mjs';

/** What the run itself changed, and what the tooling around it changed while it worked. */
const runChanges = (runDir) =>
  splitRunChanges(
    runDir,
    changedPaths(readText(path.join(runDir, 'state-before.txt')), readText(path.join(runDir, 'state-after.txt'))),
  );

export const AGENTS = {
  'codex-scout': {
    result: 'result.json',
    filled: (r) => Boolean(String(r?.answer || '').trim()),
    reply: scoutReply,
  },
  'codex-build': {
    result: 'result.json',
    filled: (r) => Boolean(String(r?.summary || '').trim()),
    reply: buildReply,
  },
  'codex-review': {
    result: 'review.json',
    filled: (r) => Boolean(String(r?.verdict || '').trim()),
    reply: reviewReply,
  },
};

function scoutReply(ctx) {
  const r = ctx.result;
  const top = (r.findings || [])[0];
  const unknowns = (r.unknowns || []).filter(Boolean);
  const coverage = scoutCoverage(ctx.runDir, r);
  return [
    `OK — ${line(r.answer, 160)}`,
    // Only when the order had several questions: with one question the ratio is noise.
    ...(coverage ? [`Покрытие: ${coverage}`] : []),
    `Ключевое: ${top ? `${line(top.fact, 130)} (${line(top.where, 60)})` : 'находок не перечислено'}`,
    `Не выяснено: ${unknowns.length ? line(unknowns.join('; '), 160) : 'нет'}`,
    `Отчёт: ${ctx.file('report.md')} · Лог: ${ctx.file('raw.log')}`,
  ];
}

function buildReply(ctx) {
  const r = ctx.result;
  const { work: touchedPaths, environment } = runChanges(ctx.runDir);
  const paths = touchedPaths.slice(0, 3).join(', ');
  const flags = readText(path.join(ctx.runDir, 'flags.txt')).split(/\r?\n/).filter(Boolean);
  const verify = r.verify_command ? line(r.verify_command, 60) : 'не запускалась';
  const verdict = r.verify_command
    ? r.verify_passed === true
      ? 'pass'
      : r.verify_passed === false
        ? 'fail'
        : 'результат не сообщён'
    : 'н/д';
  // A pass that changed nothing because the previous pass of the same task already did the
  // work says so on the files line: "0 изменено" alone reads as a run that achieved nothing.
  const files = ctx.carried
    ? `${paths ? `${paths} · ` : ''}правки сделаны предыдущим заходом этой задачи`
    : paths || 'рабочее дерево не тронуто';
  return [
    `OK — ${line(r.summary, 160)}`,
    `Файлы: ${touchedPaths.length} изменено · ${files}`,
    // Only when something outside the run wrote to the tree. Subtracting those paths from the
    // verdict without naming them would hide a real edit behind a pattern.
    ...(environment.length
      ? [`Среда: ${environment.length} изменено не прогоном — ${line(environment.slice(0, 3).join(', '), 120)}`]
      : []),
    `Проверка: ${verify} — ${verdict}`,
    `Флаги: ${flags.length ? `${flags.length} TODO/skip — ${line(flags.slice(0, 3).join(' | '), 140)}` : 'нет'}`,
    `Отчёт: ${ctx.file('report.md')} · Лог: ${ctx.file('raw.log')}`,
  ];
}

function reviewReply(ctx) {
  const r = ctx.result;
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  (r.findings || []).forEach((f) => {
    if (counts[f.severity] !== undefined) counts[f.severity] += 1;
  });
  const top = (r.findings || []).find((f) => f.severity === 'critical' || f.severity === 'high');
  return [
    `OK — вердикт ${line(r.verdict, 40)}`,
    `Находки: critical ${counts.critical} · high ${counts.high} · medium ${counts.medium} · low ${counts.low}`,
    `Топ: ${top ? `${top.severity} ${line(top.file, 80)}:${top.line_start} — ${line(top.title, 90)}` : 'критичных и высоких нет'}`,
    `Отчёт: ${ctx.file(path.basename(ctx.resultPath))} · Лог: ${ctx.file('raw.log')}`,
  ];
}

export function failReply(ctx, meta) {
  return [
    `FAIL — ${line(meta.reason, 170)}`,
    `Артефакты: raw.log ${meta.log_bytes} Б · ${path.basename(ctx.resultPath)} ${meta.result_ok ? 'заполнен' : 'пуст или отсутствует'} · exit=${meta.exit}`,
    `Лог: ${ctx.file('raw.log')}`,
  ];
}

export function limitReply(ctx, meta) {
  const rows = [
    'LIMIT — квота ChatGPT исчерпана, работа не выполнена',
    `Сигнал: ${line(meta.reason, 170)}`,
  ];
  if (ctx.agent === 'codex-build') {
    const { work: touched } = runChanges(ctx.runDir);
    rows.push(
      `Рабочее дерево: ${touched.length ? `есть незавершённые правки (${touched.length}), см. git-after.txt` : 'без новых изменений'}`,
    );
  }
  rows.push(`Лог: ${ctx.file('raw.log')}`);
  return rows;
}
