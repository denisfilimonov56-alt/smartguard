import { api } from "../api/client";
import type { Rule } from "../api/types";

/* Область действия правила по подразделениям — чистые функции для матрицы
   и панели правила. Правила те же, что в графе (api/graph.py):
     нет списка «только в»        — правило действует для всех;
     подразделение вне списка     — правило на него не распространяется;
     studentsOnly                 — правило проверяется только у целей студентов. */

/** departmentId, в которых правило действует; пусто — для всех. */
export type Scope = string[];

export type CellState = "applies" | "off";

export const cellState = (rule: Rule, departmentId: string): CellState =>
  rule.onlyIn.length && !rule.onlyIn.some((d) => d.departmentId === departmentId) ? "off" : "applies";

/** Проверяется ли правило у цели: подразделение (пусто — не указано, правило не отсекается)
    и признак студента — та же логика, что в графе. */
export const ruleApplies = (rule: Rule, departmentId: string | null, isStudent: boolean): boolean =>
  (!departmentId || cellState(rule, departmentId) !== "off") && (isStudent || !rule.studentsOnly);

export const scopeOf = (rule: Rule): Scope => rule.onlyIn.map((d) => d.departmentId);

/** Правило действует в подразделении. */
export const withApplies = (scope: Scope, id: string): Scope =>
  scope.length && !scope.includes(id) ? [...scope, id] : scope;

/** Правило на подразделение не распространяется. null — если так правило
    перестало бы действовать где-либо: пустой список означает «для всех». */
export function withOff(scope: Scope, id: string, allIds: string[]): Scope | null {
  const only = (scope.length ? scope : allIds).filter((d) => d !== id);
  return only.length ? only : null;
}

/** departmentId всех подразделений вместе с архивными — для withOff у правила «для всех».
    Список раздела зависит от флажка «Показать архив», и по нему архивные подразделения
    молча выпали бы из области действия. */
export async function allDepartmentIds(): Promise<string[]> {
  const { departments } = await api.departments(true);
  return departments.flatMap((d) => (d.departmentId ? [d.departmentId] : []));
}

/** Предупреждение при переходе правила «для всех» к списку подразделений. */
export const FUTURE_DEPARTMENTS_HINT = "Подразделения, заведённые позже, этим правилом охвачены не будут — "
  + "их придётся отметить отдельно.";

/** Короткое описание области действия — для карточек и сводок. */
export function scopeSummary(rule: Rule): string {
  const name = (d: { name: string | null; departmentId: string }) => d.name || d.departmentId;
  const where = rule.onlyIn.length ? "Только: " + rule.onlyIn.map(name).join(", ") : "Все подразделения";
  return rule.studentsOnly ? `${where} · только студенты` : where;
}
