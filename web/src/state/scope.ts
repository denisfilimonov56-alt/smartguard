import type { Rule } from "../api/types";

/* Область действия правила по подразделениям — чистые функции для матрицы
   и панели правила. Правила те же, что в графе (api/graph.py):
     нет списка «только в»        — правило действует для всех;
     подразделение вне списка     — правило на него не распространяется. */

/** departmentId, в которых правило действует; пусто — для всех. */
export type Scope = string[];

export type CellState = "applies" | "off";

export const cellState = (rule: Rule, departmentId: string): CellState =>
  rule.onlyIn.length && !rule.onlyIn.some((d) => d.departmentId === departmentId) ? "off" : "applies";

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

/** Короткое описание области действия — для карточек и сводок. */
export function scopeSummary(rule: Rule): string {
  const name = (d: { name: string | null; departmentId: string }) => d.name || d.departmentId;
  return rule.onlyIn.length ? "Только: " + rule.onlyIn.map(name).join(", ") : "Все подразделения";
}
