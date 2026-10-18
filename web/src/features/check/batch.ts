import { api, ApiError } from "../../api/client";
import type { BatchCheck, CheckStatus, Department, GoalItem, Violation } from "../../api/types";
import { writeWorkbook, type Sheet } from "../../lib/xlsx";
import type { BatchRow } from "../../state/checkForm";

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

export const place = (v: Violation) =>
  `Приказ ${v.order_number ?? "?"}, пункт ${v.clause_code ?? "?"}${v.clause_text ? " — " + v.clause_text : ""}`;

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

/** Подразделение по идентификатору или названию, без учёта регистра. */
export function resolveDepartment(text: string, departments: Department[]): Department | undefined {
  const key = text.trim().toLowerCase();
  if (!key) return undefined;
  return departments.find((d) => d.departmentId?.toLowerCase() === key)
    ?? departments.find((d) => d.name?.trim().toLowerCase() === key);
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
      if (!department) issues.push(error(`Подразделения «${departmentId}» нет в справочнике`));
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

/** Сколько раз подряд повторять часть пакета, на которую API ответил 503 «занято», и предел паузы
    (API обещает Retry-After: 30; больше двух минут ждать не будем). */
export const BUSY_RETRIES = 10;
export const BUSY_RETRY_MAX_S = 120;

/** Подождать seconds секунд с обратным отсчётом; отмена прерывает ожидание ошибкой «Запрос отменён». */
function waitRetry(seconds: number, signal: AbortSignal | undefined, onWait?: (seconds: number | null) => void) {
  return new Promise<void>((resolve, reject) => {
    let left = Math.max(1, Math.ceil(seconds));
    onWait?.(left);
    const timer = setInterval(() => {
      left -= 1;
      if (left > 0) { onWait?.(left); return; }
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
    Ответ 503 с Retry-After (API занят другими пакетами, BULK_MAX_REQUESTS) — та же часть повторяется
    через указанное время (не дольше BUSY_RETRY_MAX_S), не больше BUSY_RETRIES раз подряд. 503 без
    Retry-After (пакетная проверка выключена, обслуживание) не повторяется. onWait получает оставшиеся
    секунды ожидания каждую секунду и null, когда ожидание кончилось.
    signal останавливает пакет: текущий запрос или ожидание повтора прерывается, следующие части не отправляются. */
export async function runBatch(rows: BatchRow[], fallback: string, chunk: number, onPart: (partial: BatchCheck) => void,
  signal?: AbortSignal, onWait?: (seconds: number | null) => void): Promise<BatchCheck> {
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
    try {
      part = await api.checkGoals(items.slice(start, start + size), signal);
    } catch (err) {
      if (err instanceof ApiError && err.status === 413 && size > 1) { size = Math.max(1, Math.floor(size / 2)); continue; }
      if (err instanceof ApiError && err.status === 503 && err.retryAfter !== null && busy < BUSY_RETRIES) {
        busy++;
        await waitRetry(Math.min(err.retryAfter, BUSY_RETRY_MAX_S), signal, onWait);
        continue;
      }
      throw err;
    }
    busy = 0;
    start += size;
    total.results.push(...part.results);
    for (const key of Object.keys(total.summary) as (keyof BatchCheck["summary"])[])
      total.summary[key] += part.summary[key];
    onPart({ results: [...total.results], summary: { ...total.summary } });
  }
  return total;
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
        STATUS_LABEL[r.status],
        lines(byRule(r.violations).map(({ first, attributes }) =>
          `${first.rule_text ?? "?"} (${place(first)})${attributes.length > 1 ? ` — атрибуты: ${attributes.join(", ")}` : ""}`)),
        lines(byRule(r.violations).map(({ first }) => first.check_instruction)),
        r.detected_attributes.join(", "),
        lines(r.notes),
      ]),
    ],
  }]);
}
