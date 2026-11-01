import { api, ApiError, type BatchProgress } from "../../api/client";
import type { BatchCheck, CheckResult, CheckStatus, Department, GoalItem, Violation } from "../../api/types";
import { writeWorkbook, type Sheet } from "../../lib/xlsx";
import type { BatchRow, BatchSnapshot } from "../../state/checkForm";

/* Пакетная проверка целей: разбор листа Excel в строки, проверка строк до
   отправки, запрос к API частями и выгрузка результата. Чистые функции,
   без React — интерфейс в BatchCheck.tsx. */

/** Строк в одной пакетной проверке из интерфейса. */
export const MAX_ROWS = 500;
/** Строк на листе Excel, выше которых лист не разбирается: это уже не пакет целей, а выгрузка. */
export const SHEET_MAX_ROWS = MAX_ROWS * 4;
/** Целей в одном запросе: не больше предела API (MAX_GOALS_PER_REQUEST, по умолчанию 200), чтобы видеть
    ход проверки и не упираться в таймаут прокси на больших пакетах. */
export const CHUNK = 50;

export const STATUS_LABEL: Record<CheckStatus, string> = {
  ALLOWED: "Нарушений нет", VIOLATIONS_FOUND: "Нужно доработать", NEEDS_MANUAL_REVIEW: "Ручная проверка",
};
export const STATUS_CLASS: Record<CheckStatus, string> = {
  ALLOWED: "ok", VIOLATIONS_FOUND: "err", NEEDS_MANUAL_REVIEW: "warn",
};

/** Цель пакета, до которой API не дошёл (unchecked): не проверена — ни «ручная проверка», ни проверенная. */
export const UNCHECKED_LABEL = "Не проверено";

/** Заметка API о временном сбое проверки цели (api/agent.py FAILURE_NOTE): статус — ручная проверка,
    но цель не разбирали, и её стоит отправить снова. API отмечает такой ответ полем retryable; по тексту
    заметки узнаётся ответ старого API, где поля ещё нет. */
export const FAILURE_NOTE = "Проверку не удалось завершить из-за временного сбоя сервиса.";

type BatchResult = BatchCheck["results"][number];

/** Проверка цели сорвалась из-за временного сбоя (FAILURE_NOTE): «Проверить оставшиеся» повторит её. */
export const failedTemporarily = (r: CheckResult) =>
  r.status === "NEEDS_MANUAL_REVIEW" && !r.unchecked
  && (r.retryable === true || r.notes.some((n) => n.startsWith(FAILURE_NOTE)));

/** Сводка по ответам: непроверенные (unchecked) — отдельно, в ручную проверку не входят.
    total — все цели с ответом, включая непроверенные. */
export function summaryOf(results: CheckResult[]): BatchCheck["summary"] {
  const count = (status: CheckResult["status"]) => results.filter((r) => !r.unchecked && r.status === status).length;
  return { total: results.length, allowed: count("ALLOWED"), violations: count("VIOLATIONS_FOUND"),
    manual_review: count("NEEDS_MANUAL_REVIEW"), unchecked: results.filter((r) => r.unchecked).length };
}

/** Где правило: «Приказ ПР-01, пункт 2.4». Текст пункта — отдельно (clause_text), в подсказке. */
export const place = (v: Violation) => `Приказ ${v.order_number ?? "?"}, пункт ${v.clause_code ?? "?"}`;

/** Ключ правила нарушения: nodeId, а у ответов без него — ruleId или текст правила. */
export const ruleKey = (v: Violation) => v.rule_node_id ?? v.rule_id ?? v.rule_text ?? "";

/** Нарушения, сгруппированные по правилу: правило с несколькими атрибутами — одно нарушенное правило. */
export function byRule(violations: Violation[]): { first: Violation; attributes: string[] }[] {
  const groups = new Map<string, { first: Violation; attributes: string[] }>();
  for (const v of violations) {
    const group = groups.get(ruleKey(v));
    if (group) { if (!group.attributes.includes(v.attribute)) group.attributes.push(v.attribute); }
    else groups.set(ruleKey(v), { first: v, attributes: [v.attribute] });
  }
  return [...groups.values()];
}

/** Сколько правил API проверить не смог (unverified_rule_node_ids): ни выполненными, ни нарушенными
    их считать нельзя. Нарушенные правила сюда не входят, даже если API отдал их и там. */
export function unverifiedCount(result: CheckResult): number {
  const failed = new Set(result.violations.map((v) => v.rule_node_id).filter(Boolean));
  return new Set((result.unverified_rule_node_ids ?? []).filter((id) => !failed.has(id))).size;
}

/** Русское склонение: plural(3, ["строка", "строки", "строк"]) → «3 строки». */
export function plural(n: number, [one, few, many]: [string, string, string]): string {
  const last = n % 10;
  const word = n % 100 >= 11 && n % 100 <= 14 ? many : last === 1 ? one : last >= 2 && last <= 4 ? few : many;
  return `${n} ${word}`;
}

let seq = 0;
export const newKey = () => `r${Date.now().toString(36)}${(++seq).toString(36)}`;
export const emptyRow = (): BatchRow => ({ key: newKey(), id: "", goal: "", departmentId: "", isStudent: false });

/* ------------------------------ лист Excel ------------------------------- */

/** Номера столбцов листа; null — столбца нет. */
export interface Columns {
  goal: number | null;
  department: number | null;
  id: number | null;
  /** Столбец «Студент»: да / нет. Без него все цели считаются целями сотрудников. */
  student: number | null;
}

const GOAL_HEAD = /цел|goal|формулир/i;
/** Заголовок, который точно означает столбец с целью. */
const GOAL_EXACT = /^(цель|цели|goal|goals|формулировка|формулировка цели|текст цели|цель сотрудника)$/i;
/** «Код цели», «№ цели», «Вес цели», «Тип цели» — про цель, но не сама формулировка. */
const NOT_GOAL_HEAD = /код|№|номер|вес|тип|срок|дата|статус|\bid\b/i;
const DEPARTMENT_HEAD = /подразд|department|dept|отдел|департ|управлени|служб/i;
const ID_HEAD = /^(id|№|номер|идентиф|код|ключ)/i;
/* Только точный заголовок: «Стаж», «Обучение», «Наставник студентов» — другие столбцы. */
const STUDENT_HEAD = /^(студент|студентка|студенты|student|students|is[ _]?student)\s*\??$/i;

const YES = /^(да|yes|y|true|истина|1|\+|студент|студентка|v|✓|✔|x)$/i;
const NO = /^(нет|no|n|false|ложь|0|-|—|сотрудник|сотрудница)$/i;

/** Значение ячейки «Студент»: «да», «yes», «1», «ИСТИНА», «+», «студент» — студент;
    «нет», «0», «ЛОЖЬ», пусто — нет; null — значение непонятно. Флажок Excel читается как 1 / 0. */
export function parseStudent(text: string): boolean | null {
  const value = text.trim();
  if (!value || NO.test(value)) return false;
  return YES.test(value) ? true : null;
}

/** Ширина листа — самая длинная строка. Без Math.max(...rows): на десятках тысяч строк спред бросает RangeError. */
export function sheetWidth(rows: string[][]): number {
  let width = 0;
  for (const row of rows) if (row.length > width) width = row.length;
  return width;
}

/** Угадать столбцы по заголовку первой строки; без узнаваемого заголовка — A, B, C.
    ambiguous — столбцы, похожие на цель, если их несколько и выбран первый из них. */
export function detectColumns(rows: string[][]): { columns: Columns; header: boolean; ambiguous: number[] } {
  const head = (rows[0] ?? []).map((cell) => (cell ?? "").trim());
  const find = (re: RegExp) => {
    const i = head.findIndex((cell) => re.test(cell));
    return i < 0 ? null : i;
  };
  // Сначала точный заголовок «Цель», затем похожие, кроме «Код цели», «Вес цели» и т. п.
  const exact = head.findIndex((cell) => GOAL_EXACT.test(cell));
  const similar = head.flatMap((cell, i) =>
    (GOAL_HEAD.test(cell) && !ID_HEAD.test(cell) && !NOT_GOAL_HEAD.test(cell) ? [i] : []));
  const goal = exact >= 0 ? exact : similar[0] ?? null;
  if (goal !== null) {
    const department = find(DEPARTMENT_HEAD);
    const id = find(ID_HEAD);
    const student = find(STUDENT_HEAD);
    const taken = (i: number | null, ...others: (number | null)[]) => (i === null || others.includes(i) ? null : i);
    return { header: true, ambiguous: exact < 0 && similar.length > 1 ? similar : [], columns: {
      goal, department: taken(department, goal),
      id: taken(id, goal, department), student: taken(student, goal, department, id) } };
  }
  const width = sheetWidth(rows);
  return { header: false, ambiguous: [], columns: {
    goal: width > 0 ? 0 : null, department: width > 1 ? 1 : null, id: width > 2 ? 2 : null, student: null,
  } };
}

const nameKey = (text: string | null | undefined) => (text ?? "").trim().toLowerCase();

/** Действующие подразделения с таким названием (без учёта регистра). Названия в справочнике
    не уникальны: у двух филиалов может быть своя «Бухгалтерия». */
export const activeByName = (text: string, departments: Department[]) =>
  departments.filter((d) => d.departmentId && d.status === "active" && nameKey(d.name) === nameKey(text));

/** Подразделение по идентификатору или названию, без учёта регистра. Название сопоставляется
    только с одним действующим: одноимённых несколько — undefined, строка остаётся с исходным текстом,
    и validateRows просит указать идентификатор. Только архивное с таким названием — оно (строка
    получит понятную ошибку «в архиве»). */
export function resolveDepartment(text: string, departments: Department[]): Department | undefined {
  const key = nameKey(text);
  if (!key) return undefined;
  const byId = departments.find((d) => d.departmentId?.toLowerCase() === key);
  if (byId) return byId;
  const active = activeByName(text, departments);
  if (active.length) return active.length === 1 ? active[0] : undefined;
  return departments.find((d) => d.departmentId && nameKey(d.name) === key);
}

/** Строки таблицы из листа: пустые строки пропускаются, название подразделения заменяется идентификатором. */
export function rowsFromSheet(sheet: Sheet, columns: Columns, header: boolean, departments: Department[]): BatchRow[] {
  const cell = (row: string[], i: number | null) => (i === null ? "" : (row[i] ?? "").trim());
  const rows: BatchRow[] = [];
  sheet.rows.forEach((row, index) => {
    if ((header && index === 0) || !row.some((c) => c.trim())) return;
    const department = cell(row, columns.department);
    const studentText = cell(row, columns.student);
    const isStudent = parseStudent(studentText);
    rows.push({
      key: newKey(), line: index + 1, id: cell(row, columns.id), goal: cell(row, columns.goal),
      departmentId: resolveDepartment(department, departments)?.departmentId ?? department,
      isStudent: isStudent === true, ...(isStudent === null ? { studentText } : {}),
    });
  });
  return rows;
}

/* ------------------------------- проверка -------------------------------- */

export interface Issue {
  level: "error" | "warning";
  text: string;
}

const error = (text: string): Issue => ({ level: "error", text });
const warning = (text: string): Issue => ({ level: "warning", text });

/** Что мешает отправить строки: ошибки не дают проверить, предупреждения — только подсказка.
    goalMaxChars — предел длины цели из /auth/me (настройка API). */
export function validateRows(rows: BatchRow[], departments: Department[], fallback: string,
  goalMaxChars: number): Map<string, Issue[]> {
  const result = new Map<string, Issue[]>();
  const seen = new Map<string, number>();
  rows.forEach((row, i) => {
    const issues: Issue[] = [];
    const goal = row.goal.trim();
    if (!goal) issues.push(error("Пустая формулировка цели"));
    else if (goal.length > goalMaxChars) issues.push(error(`Цель длиннее ${goalMaxChars} символов`));

    const departmentId = row.departmentId.trim() || fallback;
    if (!departmentId) issues.push(error("Подразделение не указано"));
    else {
      const department = departments.find((d) => d.departmentId === departmentId);
      if (!department && activeByName(departmentId, departments).length > 1)
        issues.push(error(`Название «${departmentId}» относится к нескольким подразделениям — укажите идентификатор`));
      else if (!department) issues.push(error(`Подразделения «${departmentId}» нет в справочнике`));
      else if (department.status !== "active")
        issues.push(error(`Подразделение «${department.name || departmentId}» в архиве`));
    }

    if (row.studentText)
      issues.push(warning(`Непонятное значение в столбце «Студент»: «${row.studentText}» — цель считается целью сотрудника`));

    if (goal) {
      const key = goal.toLowerCase().replace(/\s+/g, " ") + "\n" + departmentId + "\n" + (row.isStudent ? "s" : "");
      const first = seen.get(key);
      if (first === undefined) seen.set(key, i);
      else issues.push(warning(`Повторяет строку ${first + 1}`));
    }
    if (issues.length) result.set(row.key, issues);
  });
  return result;
}

export const hasErrors = (issues: Issue[] | undefined) => !!issues?.some((i) => i.level === "error");

/* -------------------------------- запрос --------------------------------- */

const emptyBatch = (): BatchCheck =>
  ({ results: [], summary: { total: 0, allowed: 0, violations: 0, manual_review: 0 } });

/** Сколько раз подряд повторять часть пакета, на которую API ответил 503 «занято» или 429 «лимит»,
    и предел паузы (API обещает Retry-After: 30 при занятой очереди и до 60 с при лимите;
    больше двух минут ждать не будем). */
export const BUSY_RETRIES = 10;
export const BUSY_RETRY_MAX_S = 120;
/** Предел своей паузы на 429 без Retry-After (ограничение частоты у прокси): 2, 3, 4, 5, 5… с. */
export const PROXY_RETRY_MAX_S = 5;

/** Почему пакет ждёт: API занят другими пакетами (503) или исчерпан лимит проверок в минуту (429). */
export type WaitReason = "busy" | "rate";

/** Подождать seconds секунд с обратным отсчётом; отмена прерывает ожидание ошибкой «Запрос отменён».
    Оставшееся время считается по часам, а не по числу срабатываний таймера: в фоновой вкладке
    браузер реже будит таймеры, и отсчёт не должен из-за этого растягиваться. */
function waitRetry(seconds: number, signal: AbortSignal | undefined, onWait?: (seconds: number | null) => void) {
  return new Promise<void>((resolve, reject) => {
    const until = Date.now() + Math.max(1, Math.ceil(seconds)) * 1000;
    const left = () => Math.ceil((until - Date.now()) / 1000);
    onWait?.(left());
    const timer = setInterval(() => {
      const rest = left();
      if (rest > 0) { onWait?.(rest); return; }
      finish();
      resolve();
    }, 1000);
    const abort = () => { finish(); reject(new ApiError("Запрос отменён", -1)); };
    function finish() {
      clearInterval(timer);
      signal?.removeEventListener("abort", abort);
      onWait?.(null);
    }
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Проверить строки частями по chunk целей; после каждой части onPart получает всё проверенное к этому моменту.
    При сбое бросает ошибку, но уже полученные результаты остаются у вызывающего через onPart.
    Ответ 413 (часть больше предела API или прокси) — часть уменьшается вдвое и отправляется снова.
    Ответ 503 с Retry-After (API занят другими пакетами, BULK_MAX_REQUESTS) и 429 с Retry-After
    (исчерпан лимит проверок в минуту, checkRatePerMinute) — та же часть повторяется через указанное
    время (не дольше BUSY_RETRY_MAX_S), не больше BUSY_RETRIES раз подряд. 429 без Retry-After
    (limit_req у nginx, тело не JSON) — повтор через свою паузу 2–5 с с нарастанием. 503 без Retry-After
    (пакетная проверка выключена, обслуживание) не повторяется. onWait получает оставшиеся
    секунды ожидания каждую секунду и причину, и null, когда ожидание кончилось.
    signal останавливает пакет: текущий запрос или ожидание повтора прерывается, следующие части не отправляются. */
/** Как часто спрашивать ход части пакета, мс. */
const LIVE_POLL_MS = 500;
/** Номер части для X-Check-Id: randomUUID есть только в защищённом контексте (https, localhost). */
const newPartId = () => globalThis.crypto?.randomUUID?.()
  ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

/** Ход части пакета: offset — номер первой цели части среди rows; final — последний снимок части. */
export type OnLive = (offset: number, progress: BatchProgress, final: boolean) => void;

/** Спрашивать ход части, пока она идёт; API без хода (404, ошибка) больше не спрашиваем. */
async function followPart(partId: string, offset: number, onLive: OnLive, done: { value: boolean }) {
  while (!done.value) {
    await new Promise((resolve) => setTimeout(resolve, LIVE_POLL_MS));
    if (done.value) return;
    try {
      onLive(offset, await api.batchProgress(partId), false);
    } catch {
      return;
    }
  }
}

export async function runBatch(rows: BatchRow[], fallback: string, chunk: number, onPart: (partial: BatchCheck) => void,
  signal?: AbortSignal, onWait?: (seconds: number | null, reason: WaitReason) => void, onLive?: OnLive): Promise<BatchCheck> {
  const items: GoalItem[] = rows.map((r) => ({
    goal: r.goal.trim(), department_id: r.departmentId.trim() || fallback, is_student: r.isStudent,
    id: r.id.trim() || null,
  }));
  const total = emptyBatch();
  let size = Math.max(1, Math.floor(chunk));
  let busy = 0;
  for (let start = 0; start < items.length;) {
    if (signal?.aborted) throw new ApiError("Запрос отменён", -1);
    let part: BatchCheck;
    const partId = newPartId();
    const finished = { value: false };
    if (onLive) void followPart(partId, start, onLive, finished);
    try {
      part = await api.checkGoals(items.slice(start, start + size), signal, onLive ? partId : undefined);
      finished.value = true;
      // Последний снимок части — с временем всех её целей и токенами.
      if (onLive) await api.batchProgress(partId).then((last) => onLive(start, last, true), () => undefined);
    } catch (err) {
      finished.value = true;
      if (err instanceof ApiError && err.status === 413 && size > 1) { size = Math.max(1, Math.floor(size / 2)); continue; }
      // 429 без Retry-After — ограничение частоты запросов у прокси (nginx limit_req, тело — его HTML-страница):
      // своя пауза с нарастанием, 2–5 с.
      const pause = err instanceof ApiError && err.status === 429 && err.retryAfter === null
        ? Math.min(2 + busy, PROXY_RETRY_MAX_S) : err instanceof ApiError ? err.retryAfter : null;
      if (err instanceof ApiError && (err.status === 503 || err.status === 429) && pause !== null
        && busy < BUSY_RETRIES) {
        busy++;
        const reason: WaitReason = err.status === 429 ? "rate" : "busy";
        await waitRetry(Math.min(pause, BUSY_RETRY_MAX_S), signal, (seconds) => onWait?.(seconds, reason));
        continue;
      }
      throw err;
    }
    busy = 0;
    start += size;
    total.results.push(...part.results);
    // Сводка — по ответам, а не сложением сводок API: там непроверенные цели входят в ручную проверку.
    total.summary = summaryOf(total.results);
    onPart({ results: [...total.results], summary: { ...total.summary } });
  }
  return total;
}

/* --------------------------- продолжение пакета --------------------------- */

/** Строка та же, что проверялась: цель, признак студента, идентификатор и подразделение
    (пустое — подразделение по умолчанию того запуска). */
export const sameRow = (a: BatchRow, b: BatchRow, fallback: string, checkedFallback: string) =>
  a.goal.trim() === b.goal.trim() && a.isStudent === b.isStudent && a.id.trim() === b.id.trim()
  && (a.departmentId.trim() || fallback) === (b.departmentId.trim() || checkedFallback);

/** Ответ прошлой проверки, который ещё относится к строке; undefined — строку не проверяли, изменили,
    API её не проверил (unchecked: пакет остановили по сроку) или проверка сорвалась из-за временного
    сбоя (failedTemporarily) — такие строки отправляются снова. */
export function checkedResults(rows: BatchRow[], fallback: string, batch: BatchSnapshot | null): (BatchResult | undefined)[] {
  if (!batch) return rows.map(() => undefined);
  const byKey = new Map(batch.rows.map((r, i) => [r.key, { row: r, result: batch.result.results[i] }]));
  return rows.map((row) => {
    const hit = byKey.get(row.key);
    return hit?.result && !hit.result.unchecked && !failedTemporarily(hit.result) && sameRow(row, hit.row, fallback, batch.fallback)
      ? hit.result : undefined;
  });
}

/** Снимок пакета после продолжения: строки в порядке таблицы — проверенные раньше (kept) и проверенные
    сейчас (fresh, по порядку непроверенных строк); строки, до которых очередь не дошла, в снимок не входят.
    Подразделение по умолчанию — текущее: строка без своего подразделения сохраняется, только если
    оно не менялось (иначе sameRow её не узнал бы). Сводка пересчитывается по статусам (summaryOf). */
export function mergeBatch(rows: BatchRow[], fallback: string, kept: (BatchResult | undefined)[],
  fresh: BatchResult[]): BatchSnapshot {
  const outRows: BatchRow[] = [];
  const results: BatchResult[] = [];
  let next = 0;
  rows.forEach((row, i) => {
    const old = kept[i];
    if (old) {
      outRows.push(row);
      results.push(old);
    } else if (next < fresh.length) {
      outRows.push(row);
      results.push(fresh[next++]);
    }
  });
  return { rows: outRows, fallback, result: { results, summary: summaryOf(results) } };
}

/* -------------------------------- Excel ---------------------------------- */

const SAMPLE_GOALS = [
  "Снизить долю просроченных заявок до 5% к 31.12.2025 в рамках проекта «Альфа»",
  "Улучшить работу с заявками",
];

/** Шаблон для заполнения: лист с целями и справочник подразделений рядом. */
export function templateWorkbook(departments: Department[]): Uint8Array {
  const active = departments.filter((d) => d.departmentId && d.status === "active");
  const sample = active[0]?.departmentId ?? "";
  return writeWorkbook([
    { name: "Цели", widths: [80, 22, 18, 10], rows: [
      ["Цель", "Подразделение", "Идентификатор", "Студент"],
      ...SAMPLE_GOALS.map((goal, i) => [goal, sample, `kpi-${i + 1}`, i === 0 ? "нет" : "да"]),
    ] },
    { name: "Подразделения", widths: [22, 50], rows: [
      ["Идентификатор", "Название"],
      ...active.map((d) => [d.departmentId!, d.name]),
    ] },
  ]);
}

/** Результат проверки — лист Excel: по строке на цель, нарушения и заметки через перевод строки. */
export function resultsWorkbook(rows: BatchRow[], result: BatchCheck): Uint8Array {
  const lines = (items: (string | null | undefined)[]) => items.filter(Boolean).join("\n");
  return writeWorkbook([{
    name: "Результат", widths: [5, 16, 60, 24, 10, 20, 60, 50, 28, 50],
    rows: [
      ["№", "Идентификатор", "Цель", "Подразделение", "Студент", "Результат", "Нарушения", "Как исправить",
        "Найдено в цели", "Заметки"],
      ...result.results.map((r, i) => [
        i + 1, r.id ?? "", r.goal,
        r.department ? r.department.name || r.department.id : rows[i]?.departmentId ?? "",
        r.is_student ? "да" : "нет",
        r.unchecked ? UNCHECKED_LABEL : STATUS_LABEL[r.status],
        lines(byRule(r.violations).map(({ first, attributes }) =>
          `${first.rule_text ?? "?"} (${place(first)})${attributes.length > 1 ? ` — атрибуты: ${attributes.join(", ")}` : ""}`)),
        lines(byRule(r.violations).map(({ first }) => first.check_instruction)),
        r.detected_attributes.join(", "),
        lines(r.notes),
      ]),
    ],
  }]);
}
