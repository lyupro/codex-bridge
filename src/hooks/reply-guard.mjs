#!/usr/bin/env node
/**
 * SubagentStop guard for the Codex dispatchers (codex-scout / codex-build / codex-review).
 *
 * Their contract is that the reply IS the runner's stdout: a `RUN=<folder>` line plus the
 * status block printed by write-meta.mjs. Prose forbids anything else, and prose has been
 * ignored twice — once a dispatcher reviewed the diff itself (68k Claude tokens instead of
 * five lines), once it announced a background run that never existed. Neither is visible
 * from the reply alone, which is why this check lives outside the model.
 *
 * It blocks on substance only:
 *   - no usable `RUN=` path in the reply (the dispatcher did not delegate at all);
 *   - status.json says the run is still going, or was abandoned, before meta.json exists;
 *   - the run folder has no meta.json (the reply rests on nothing);
 *   - the reply's status word contradicts meta.json.
 *
 * Cosmetics — code fences, blank lines, reordered whitespace — pass. Blocking those would
 * spend Claude tokens on a re-answer that changes no decision.
 *
 * Those four reasons are of two different kinds, and they get two different budgets: an
 * argument about the SHAPE of the reply can loop forever and eventually steps aside, an
 * argument about EXTERNAL run state cannot be argued away by the model and ends the turn
 * with `continue: false` instead of a silent pass. See MAX_FORM_BLOCKS / MAX_STATE_BLOCKS.
 *
 * Input is JSON on stdin. The fields used here (`agent_type`, `last_assistant_message`)
 * come from Claude Code; the last payload is kept in logs/codex-reply-guard.last.json so
 * the contract stays inspectable if it ever changes shape.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const LOG_DIR = path.join(HOME, '.claude', 'logs');
const BLOCKED_FILE = path.join(LOG_DIR, 'codex-reply-guard.blocked.json');
const GUARDED = new Set(['codex-scout', 'codex-build', 'codex-review']);
const STATUSES = ['OK', 'FAIL', 'LIMIT'];

/**
 * How many times a single agent may be blocked over the SHAPE of its reply — no RUN= line,
 * no meta.json, a status word that contradicts meta.json. 1 is too few: the incident that
 * prompted this constant was a dispatcher blocked once, retried, and answered wrong again
 * ("run started in background, waiting 5-10 minutes") — the old one-shot guard let that
 * second wrong answer straight through. Unbounded is worse: here the argument is with the
 * model, and a dispatcher stuck re-answering the same way loops forever and burns Claude
 * quota on retries that never converge. Three tries, then let it through so the operator
 * sees a reply with substance in it and judges for himself.
 */
const MAX_FORM_BLOCKS = 3;

/**
 * The same allowance for blocks caused by EXTERNAL state — the run is still going, or its
 * runner died. Counted separately because the two run out for unrelated reasons: three
 * malformed replies must not spend the budget that protects a live worktree, and a live
 * worktree is not something the model can answer its way out of. Exhausting this one does
 * NOT step aside — see the stopReason path below. What went through the shared budget was
 * "Жду завершения прогона Codex... Monitor запущен в фоне. Буду ждать уведомления",
 * promised over a run whose runner was already dead (counter a662d99e0c67d3a8a => 3): the
 * orchestrator got a promise from a process that no longer existed and never learned the
 * worktree was busy.
 */
const MAX_STATE_BLOCKS = 3;

const FORM = 'form';
const STATE = 'state';

/** Never let a guard failure break real work: on any doubt, stay silent. */
const pass = () => process.exit(0);

let input;
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch {
  pass();
}

try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(path.join(LOG_DIR, 'codex-reply-guard.last.json'), `${JSON.stringify(input, null, 2)}\n`);
} catch {
  // Diagnostics are a convenience, never a reason to fail the turn.
}

// Only the Codex dispatchers have this contract. Every other agent is none of our
// business — an earlier version inferred the agent from transcript text and blocked an
// unrelated one, which cost a re-answer for nothing.
if (!GUARDED.has(input.agent_type)) pass();

const reply = String(input.last_assistant_message || '').trim();
if (!reply) pass();

/**
 * Reads one stored entry into {form, state}. Three shapes live in this file at once and all
 * three must keep their meaning: the current pair, the single number written by the previous
 * version, and an ISO string from the version before that (it meant "blocked once"). A
 * number is read as form tries — that budget is the one the old counter mostly guarded.
 * Anything else counts as one form try already spent, so an agent recorded before this fix
 * does not silently get its tries back.
 */
const readCounts = (prior) => {
  const whole = (value) => (Number.isInteger(value) && value > 0 ? value : 0);
  if (prior && typeof prior === 'object' && !Array.isArray(prior)) {
    return { form: whole(prior.form), state: whole(prior.state) };
  }
  if (typeof prior === 'number') return { form: whole(prior), state: 0 };
  return { form: prior ? 1 : 0, state: 0 };
};

/**
 * Spends one try of the named budget. stop_hook_active is not reliable here (it already
 * arrives true in normal runs), so the loop protection is our own.
 *
 *   'granted'   — block normally, a try was recorded;
 *   'exhausted' — this budget is used up, the caller decides what that means;
 *   'untracked' — the guard cannot count at all (no agent id, log not writable). A guard
 *                 that cannot count must not decide anything, least of all end a session.
 */
const takeTry = (agentId, kind) => {
  if (!agentId) return 'untracked';
  let seen;
  try {
    seen = JSON.parse(fs.readFileSync(BLOCKED_FILE, 'utf8'));
  } catch {
    seen = {};
  }
  if (!seen || typeof seen !== 'object' || Array.isArray(seen)) seen = {};
  const counts = readCounts(seen[agentId]);
  if (counts[kind] >= (kind === STATE ? MAX_STATE_BLOCKS : MAX_FORM_BLOCKS)) return 'exhausted';
  counts[kind] += 1;
  seen[agentId] = counts;
  // Keep the file from growing without bound; order of insertion is good enough.
  const ids = Object.keys(seen);
  if (ids.length > 200) ids.slice(0, ids.length - 200).forEach((id) => delete seen[id]);
  try {
    fs.writeFileSync(BLOCKED_FILE, `${JSON.stringify(seen)}\n`);
  } catch {
    return 'untracked';
  }
  return 'granted';
};

const emit = (payload) => {
  process.stdout.write(JSON.stringify(payload));
  process.exit(0);
};

/** Wrong shape of reply: three tries, then the reply goes through as it always has. */
const blockForm = (reason) => {
  if (takeTry(input.agent_id, FORM) !== 'granted') pass();
  emit({ decision: 'block', reason });
};

/**
 * Wrong external state: three tries, then the turn ends with stopReason instead of the
 * silent pass. Silence here is what let a run in progress be reported as finished business
 * — the operator saw a confident reply and nothing about the worktree being occupied.
 */
const blockState = (reason, stopReason) => {
  const verdict = takeTry(input.agent_id, STATE);
  if (verdict === 'granted') emit({ decision: 'block', reason });
  if (verdict === 'exhausted') emit({ continue: false, stopReason });
  pass();
};

const runMatch = reply.match(/RUN=(.+?)(?:\r?\n|$)/);
const runDir = runMatch ? runMatch[1].trim().replace(/[`"'*]+$/g, '') : null;

if (!runDir || !fs.existsSync(runDir)) {
  blockForm(
    'Контракт нарушен: в ответе нет строки RUN= с существующей папкой прогона, то есть ' +
      'делегирование в Codex не подтверждено. Запусти run-codex.mjs и верни его stdout ' +
      'дословно — строку RUN=<путь> и блок статуса под ней. Если прогон не состоялся, ' +
      'доложи это статусом раннера: собственный анализ вместо Codex запрещён при любом исходе.',
  );
}

/**
 * Best-effort liveness probe: signal 0 sends nothing, it only tests that the pid exists.
 * EPERM means the process is there and owned by someone else — alive for our purposes, and
 * the same reading write-meta.mjs uses. Two answers to "is this run still going" would be
 * one answer too many.
 */
const isPidAlive = (pid) => {
  if (typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

/**
 * The text the operator reads when the state budget is gone. Everything in it is quoted
 * from status.json — the operator is being told to stop, and a stop justified by guesswork
 * is a stop he learns to ignore. `fact` names the missing field instead of inventing one.
 */
const fact = (value) => (value === undefined || value === null || value === '' ? 'не записан' : String(value));

const stopText = (headline, observed, runStatus) =>
  [
    headline,
    `Прогон: слаг ${fact(runStatus?.slug)}, агент ${fact(runStatus?.agent)}, репозиторий ` +
      `${fact(runStatus?.repo)}, старт ${fact(runStatus?.started_at)}.`,
    `Папка прогона: ${runDir}. Состояние читать в ${path.join(runDir, 'status.json')}, вердикт ` +
      'появится в meta.json рядом с ним.',
    observed,
    `Рабочее дерево ${fact(runStatus?.repo)} занято этим прогоном: не собирать, не запускать ` +
      'тесты и не коммитить, пока status.json не сменит state на finished или failed. Раннер ' +
      'снимает дерево до и после прогона и засчитает себе любые правки, сделанные в это окно.',
    'Прогон закроется сам: раннер переживает обрыв вызова Bash и дописывает meta.json и ' +
      'status.json без диспетчера. Дождись смены state и перечитай status.json — вердикт будет ' +
      'там, переспрашивать диспетчера незачем.',
  ].join(' ');

/**
 * status.json is written by run-codex.mjs before meta.json exists, so it catches the
 * dispatcher that reports before its own run is done — meta.json alone cannot, because a
 * run in progress simply has none yet, same as a run that was never started. Runs from
 * before status.json existed have none: behave exactly as before (meta.json decides).
 */
const statusPath = path.join(runDir, 'status.json');
if (fs.existsSync(statusPath)) {
  let runStatus = null;
  try {
    runStatus = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  } catch {
    runStatus = null;
  }
  if (runStatus?.state === 'running') {
    if (isPidAlive(runStatus.pid)) {
      blockState(
        'Контракт нарушен: status.json говорит state=running и процесс ещё жив — прогон не ' +
          'завершён, а ты уже отвечаешь. Запускай run-codex.mjs синхронно, одним вызовом Bash ' +
          'с timeout 1800000, а не в фоне: уведомления после твоего выхода не будет, и ответ ' +
          'до завершения прогона не подтверждён ничем.',
        stopText(
          `Сторож остановил сессию: диспетчер ${MAX_STATE_BLOCKS} раза отвечал поверх прогона ` +
            'Codex, который ещё идёт.',
          `Сейчас status.json говорит state=running, процесс pid ${fact(runStatus.pid)} жив.`,
          runStatus,
        ),
      );
    }
    if (!fs.existsSync(path.join(runDir, 'meta.json'))) {
      blockState(
        'Контракт нарушен: status.json говорит state=running, но процесс с этим pid мёртв и ' +
          'meta.json нет — прогон брошен, скорее всего вызов оборвался по таймауту в 2 минуты, ' +
          'а честный прогон длится 20-25 минут. Повтори run-codex.mjs с timeout не меньше ' +
          '1800000 и верни его stdout дословно.',
        stopText(
          `Сторож остановил сессию: диспетчер ${MAX_STATE_BLOCKS} раза отвечал за прогон, ` +
            'который он не довёл.',
          `Сейчас status.json говорит state=running, но процесс pid ${fact(runStatus.pid)} мёртв ` +
            'и meta.json нет: раннер убит обрывом вызова Bash. Сам Codex смерть раннера ' +
            'переживает и правит дерево дальше — в прогоне 2026-07-31_114736 так уцелели правки ' +
            'в 11+ файлах, при том что raw.log и meta.json не записаны вовсе.',
          runStatus,
        ),
      );
    }
  } else if (runStatus?.state === 'abandoned') {
    blockState(
      'Контракт нарушен: status.json говорит state=abandoned — прогон брошен, скорее всего ' +
        'вызов оборвался по таймауту в 2 минуты, а честный прогон длится 20-25 минут. Повтори ' +
        'run-codex.mjs с timeout не меньше 1800000 и верни его stdout дословно.',
      stopText(
        `Сторож остановил сессию: диспетчер ${MAX_STATE_BLOCKS} раза отвечал за брошенный прогон.`,
        `Сейчас status.json говорит state=abandoned (${fact(runStatus.abandoned_reason)}, ` +
          `${fact(runStatus.abandoned_at)}): раннер умер, не записав вердикт. Сам Codex смерть ` +
          'раннера переживает и правит дерево дальше — в прогоне 2026-07-31_114736 так уцелели ' +
          'правки в 11+ файлах, при том что raw.log и meta.json не записаны вовсе.',
        runStatus,
      ),
    );
  }
}

const metaPath = path.join(runDir, 'meta.json');
if (!fs.existsSync(metaPath)) {
  blockForm(
    `Контракт нарушен: в папке прогона ${runDir} нет meta.json, ответ ничем не подтверждён. ` +
      'Прогони run-codex.mjs заново и верни его stdout дословно.',
  );
}

let meta;
try {
  meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
} catch {
  pass();
}

const claimed = STATUSES.find((status) => new RegExp(`(^|\\n)\\s*\`*${status}\\b`).test(reply));
if (claimed && meta.status && claimed !== meta.status) {
  blockForm(
    `Контракт нарушен: ты доложил ${claimed}, а meta.json прогона говорит ${meta.status} ` +
      `(${meta.reason || 'без причины'}). Статус считает раннер по артефактам — верни его вывод ` +
      'дословно, не подменяя своим суждением.',
  );
}

pass();
