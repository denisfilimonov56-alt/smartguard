import type { CheckTarget, Clause, Example, Order, Rule } from "../api/types";

/* Поиск и обход дерева каталога. Чистые функции — без состояния React. */

export type AnyNode = Order | Clause | Rule | Example | CheckTarget;

export const allClauses = (orders: Order[]) => orders.flatMap((o) => o.clauses);
export const allRules = (orders: Order[]) => allClauses(orders).flatMap((c) => c.rules);
export const allExamples = (orders: Order[]) => allRules(orders).flatMap((r) => r.examples);

export function findNode(orders: Order[], targets: CheckTarget[], nodeId: string): AnyNode | undefined {
  const by = <T extends { nodeId: string }>(list: T[]) => list.find((x) => x.nodeId === nodeId);
  return by(orders) ?? by(allClauses(orders)) ?? by(allRules(orders)) ?? by(allExamples(orders)) ?? by(targets);
}

/** Приказ и пункт, внутри которых лежит узел (пункта нет, если узел — сам приказ). */
export function findOrderOf(orders: Order[], nodeId: string): { order: Order; clause?: Clause } | null {
  for (const order of orders) {
    if (order.nodeId === nodeId) return { order };
    for (const clause of order.clauses) {
      const inside = clause.nodeId === nodeId || clause.rules.some((r) =>
        r.nodeId === nodeId || r.examples.some((e) => e.nodeId === nodeId));
      if (inside) return { order, clause };
    }
  }
  return null;
}

const ruleText = (r: Rule) => [
  r.ruleId, r.description, r.checkInstruction, ...r.targets, ...r.examples.map((e) => e.text),
];

const clauseText = (c: Clause) => [c.code, c.text, c.clauseId, ...c.rules.flatMap(ruleText)];

const contains = (parts: unknown[], query: string) =>
  parts.map((p) => String(p ?? "")).join(" ").toLowerCase().includes(query);

export const normalizeQuery = (q: string) => q.trim().toLowerCase();

export const orderMatches = (order: Order, query: string) =>
  !query || contains([order.number, order.title, order.orderId, ...order.clauses.flatMap(clauseText)], query);

/** При активном поиске совпавшие пункты раскрываются сами: иначе результат
    прячется внутри свёрнутых пунктов. */
export const clauseMatches = (clause: Clause, query: string) => !!query && contains(clauseText(clause), query);

/** Правило вместе с пунктом и приказом, к которым оно относится. */
export interface RuleRef {
  order: Order;
  clause: Clause;
  rule: Rule;
}

export const allRuleRefs = (orders: Order[]): RuleRef[] =>
  orders.flatMap((order) => order.clauses.flatMap((clause) => clause.rules.map((rule) => ({ order, clause, rule }))));

export const findRuleRef = (orders: Order[], nodeId: string): RuleRef | undefined =>
  allRuleRefs(orders).find((ref) => ref.rule.nodeId === nodeId || ref.rule.examples.some((e) => e.nodeId === nodeId));

/** Правила, которые реально участвуют в проверке: активна вся цепочка и есть признаки. */
export const activeRuleRefs = (orders: Order[]): RuleRef[] =>
  allRuleRefs(orders).filter(({ order, clause, rule }) =>
    order.status === "active" && clause.status === "active" && rule.status === "active" && rule.targets.length > 0);

export const ruleMatches = ({ order, clause, rule }: RuleRef, query: string) =>
  !query || contains([order.number, clause.code, clause.text, ...ruleText(rule)], query);
