import { api } from "../../api/client";
import type { BatchCheck, CheckStatus, Department, GoalItem, Violation } from "../../api/types";
import { writeWorkbook, type Sheet } from "../../lib/xlsx";
import type { BatchRow } from "../../state/catalog";

/* Пакетная проверка целей: разбор листа Excel в строки, проверка строк до
   отправки, запрос к API частями и выгрузка результата. Чистые функции,
   без React — интерфейс в BatchCheck.tsx. */

/** Строк в одной пакетной проверке из интерфейса. */
export const MAX_ROWS = 500;
/** Длиннее этого цель не бывает: тот же предел, что у советчика (api/schemas.py). */
export const GOAL_MAX_CHARS = 4000;
/** Целей в одном запросе: меньше предела API (MAX_GOALS_PER_REQUEST = 200), чтобы видеть ход проверки
    и не упираться в таймаут прокси на больших пакетах. */
export const CHUNK = 50;

export const STATUS_LABEL: Record<CheckStatus, string> = {
  ALLOWED: "Нарушений нет", VIOLATIONS_FOUND: "Нужно доработать", NEEDS_MANUAL_REVIEW: "Ручная проверка",
};
export const STATUS_CLASS: Record<CheckStatus, string> = {
  ALLOWED: "ok", VIOLATIONS_FOUND: "err", NEEDS_MANUAL_REVIEW: "warn",
};

export const place = (v: Violation) =>
  `Приказ ${v.order_number ?? "?"}, пункт ${v.clause_code ?? "?"}${v.clause_text ? " — " + v.clause_text : ""}`;

/** Русское склонение: plural(3, ["строка", "строки", "строк"]) → «3 строки». */
export function plural(n: number, [one, few, many]: [string, string, string]): string {
  const last = n % 10;
  const word = n % 100 >= 11 && n % 100 <= 14 ? many : last === 1 ? one : last >= 2 && last <= 4 ? few : many;
  return `${n} ${word}`;
}

let seq = 0;
export const newKey = () => `r${Date.now().toString(36)}${(++seq).toString(36)}`;
export const emptyRow = (): BatchRow => ({ key: newKey(), id: "", goal: "", departmentId: "" });

/* ------------------------------ лист Excel ------------------------------- */

/** Номера столбцов листа; null — столбца нет. */
export interface Columns {
  goal: number | null;
  department: number | null;
  id: number | null;
}

const GOAL_HEAD = /цел|goal|формулир/i;
const DEPARTMENT_HEAD = /подразд|department|dept|отдел|департ|управлени|служб/i;
const ID_HEAD = /^(id|№|номер|идентиф|код|ключ)/i;

/** Угадать столбцы по заголовку первой строки; без узнаваемого заголовка — A, B, C. */
export function detectColumns(rows: string[][]): { columns: Columns; header: boolean } {
  const head = rows[0] ?? [];
  const find = (re: RegExp) => {
    const i = head.findIndex((cell) => re.test(cell.trim()));
    return i < 0 ? null : i;
  };
  const goal = find(GOAL_HEAD);
  if (goal !== null) {
    const department = find(DEPARTMENT_HEAD);
    const id = find(ID_HEAD);
    return { header: true, columns: { goal, department: department === goal ? null : department,
      id: id === goal || id === department ? null : id } };
  }
  const width = Math.max(0, ...rows.map((r) => r.length));
  return { header: false, columns: { goal: width > 0 ? 0 : null, department: width > 1 ? 1 : null, id: width > 2 ? 2 : null } };
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
    rows.push({
      key: newKey(), line: index + 1, id: cell(row, columns.id), goal: cell(row, columns.goal),
      departmentId: resolveDepartment(department, departments)?.departmentId ?? department,
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

/** Что мешает отправить строки: ошибки не дают проверить, предупреждения — только подсказка. */
export function validateRows(rows: BatchRow[], departments: Department[], fallback: string): Map<string, Issue[]> {
  const result = new Map<string, Issue[]>();
  const seen = new Map<string, number>();
  rows.forEach((row, i) => {
    const issues: Issue[] = [];
    const goal = row.goal.trim();
    if (!goal) issues.push(error("Пустая формулировка цели"));
    else if (goal.length > GOAL_MAX_CHARS) issues.push(error(`Цель длиннее ${GOAL_MAX_CHARS} символов`));

    const departmentId = row.departmentId.trim() || fallback;
    if (!departmentId) issues.push(error("Подразделение не указано"));
    else {
      const department = departments.find((d) => d.departmentId === departmentId);
      if (!department) issues.push(error(`Подразделения «${departmentId}» нет в справочнике`));
      else if (department.status !== "active")
        issues.push(error(`Подразделение «${department.name || departmentId}» в архиве`));
    }

    if (goal) {
      const key = goal.toLowerCase().replace(/\s+/g, " ") + "\n" + departmentId;
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

/** Проверить строки частями по CHUNK целей; после каждой части onPart получает всё проверенное к этому моменту.
    При сбое бросает ошибку, но уже полученные результаты остаются у вызывающего через onPart. */
export async function runBatch(rows: BatchRow[], fallback: string, onPart: (partial: BatchCheck) => void): Promise<BatchCheck> {
  const items: GoalItem[] = rows.map((r) => ({
    goal: r.goal.trim(), department_id: r.departmentId.trim() || fallback, id: r.id.trim() || null,
  }));
  const total = emptyBatch();
  for (let start = 0; start < items.length; start += CHUNK) {
    const part = await api.checkGoals(items.slice(start, start + CHUNK));
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
    { name: "Цели", widths: [80, 22, 18], rows: [
      ["Цель", "Подразделение", "Идентификатор"],
      ...SAMPLE_GOALS.map((goal, i) => [goal, sample, `kpi-${i + 1}`]),
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
    name: "Результат", widths: [5, 16, 60, 24, 20, 60, 50, 28, 50],
    rows: [
      ["№", "Идентификатор", "Цель", "Подразделение", "Результат", "Нарушения", "Как исправить", "Найдено в цели", "Заметки"],
      ...result.results.map((r, i) => [
        i + 1, r.id ?? "", r.goal,
        r.department ? r.department.name || r.department.id : rows[i]?.departmentId ?? "",
        STATUS_LABEL[r.status],
        lines(r.violations.map((v) => `${v.rule_text ?? "?"} (${place(v)})`)),
        lines(r.violations.map((v) => v.check_instruction)),
        r.detected_attributes.join(", "),
        lines(r.notes),
      ]),
    ],
  }]);
}
