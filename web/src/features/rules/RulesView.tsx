import { useState } from "react";

import type { Department, Rule } from "../../api/types";
import { useAuth } from "../../state/auth";
import { useCatalog } from "../../state/catalog";
import { cellState, type CellState } from "../../state/scope";
import { allRuleRefs, normalizeQuery, ruleMatches, type RuleRef } from "../../state/tree";
import { ArchivedBadge } from "../../ui/common";
import { Select } from "../../ui/Select";
import { useActions } from "../actions";
import { useCellEditor } from "./CellEditor";
import { RuleWizard } from "./RuleWizard";

/* Главный рабочий экран владельца приказа: строка — правило, столбец —
   подразделение. В ячейке сразу видно, действует ли правило, и там же
   это меняется. Клик по названию правила открывает его панель. */

const STATE_LABEL: Record<CellState, string> = { applies: "действует", off: "не действует" };

const Cell = ({ state }: { state: CellState }) =>
  state === "applies" ? <span className="cell yes">✓</span> : <span className="cell no">—</span>;

export function RulesView() {
  const { wizard } = useCatalog();
  return (
    <section id="tab-rules">
      {wizard ? <RuleWizard preset={wizard} /> : <Matrix />}
    </section>
  );
}

function Matrix() {
  const { orders, departments, showArchived, reload, openRule, openWizard, panelRule } = useCatalog();
  const actions = useActions();
  const { canEdit } = useAuth();
  const editCell = useCellEditor();
  const [search, setSearch] = useState("");
  const [orderFilter, setOrderFilter] = useState("");
  const [focus, setFocus] = useState<string | null>(null);
  const query = normalizeQuery(search);

  const columns = departments.filter((d) => d.departmentId);
  const groups = orders
    .filter((o) => !orderFilter || o.nodeId === orderFilter)
    .map((order) => ({ order, refs: allRuleRefs([order]).filter((ref) => ruleMatches(ref, query)) }))
    .filter((g) => g.refs.length);
  function open(rule: Rule, department: Department, anchor: HTMLElement) {
    const key = rule.nodeId + department.nodeId;
    setFocus(key);
    editCell({ rule, department, anchor: anchor.getBoundingClientRect() });
  }

  const row = ({ clause, rule }: RuleRef) => (
    <tr key={rule.nodeId} data-node={rule.nodeId} className={`${panelRule === rule.nodeId ? "selected" : ""}`}>
      <td className={`rule-col ${rule.status === "archived" ? "is-archived" : ""}`} onClick={() => openRule(rule.nodeId)}>
        <div className="t">{rule.description || "(без формулировки)"}</div>
        <div className="s">
          п. {clause.code || "?"} · {rule.type === "PROHIBITION" ? "запрет" : "требование"}
          <ArchivedBadge status={rule.status} />
          {!rule.targets.length && <span className="badge warn">нет атрибутов — не сработает</span>}
        </div>
      </td>
      {columns.map((d) => {
        const state = cellState(rule, d.departmentId!);
        const key = rule.nodeId + d.nodeId;
        return (
          <td key={d.nodeId}>
            <button className={`cell-btn ${focus === key ? "focus" : ""}`} data-state={state} disabled={!canEdit}
              aria-label={`${rule.description} — ${d.name || d.departmentId}: ${STATE_LABEL[state]}`}
              onClick={(e) => open(rule, d, e.currentTarget)} onBlur={() => setFocus(null)}>
              <Cell state={state} />
            </button>
          </td>
        );
      })}
    </tr>
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Где какое правило действует</h1>
          <div className="sub">Строка — правило из приказа, столбец — подразделение.{canEdit && " Нажмите на ячейку, чтобы изменить."}</div>
        </div>
        {canEdit && (
          <div className="row">
            <button className="btn" onClick={actions.addDepartment}>+ Подразделение</button>
            <button className="btn primary" onClick={() => openWizard()}>+ Правило</button>
          </div>
        )}
      </div>

      <div className="toolbar">
        <Select className="pill" style={{ width: 230 }} ariaLabel="Приказ" value={orderFilter} onChange={setOrderFilter}
          options={[{ value: "", label: "Все приказы" },
            ...orders.map((o) => ({ value: o.nodeId, label: o.number || o.orderId || "(без номера)" }))]} />
        <input type="search" className="pill grow" placeholder="Поиск по правилам…" value={search}
          onChange={(e) => setSearch(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={showArchived}
            onChange={(e) => void reload({ showArchived: e.target.checked })} /> Архив
        </label>
      </div>
      <div className="toolbar">
        <div className="legend">
          <span><span className="cell yes mini">✓</span>действует</span>
          <span><span className="cell no mini">—</span>не действует</span>
        </div>
      </div>

      {groups.length ? (
        <div className="card matrix">
          <table>
            <thead>
              <tr>
                <th className="rule-col">Правило</th>
                {columns.map((d) => (
                  <th key={d.nodeId} className={d.status === "archived" ? "is-archived" : ""}>{d.name || d.departmentId}</th>
                ))}
                {!columns.length && <th style={{ textAlign: "left" }}>Подразделений нет — правила действуют для всех</th>}
              </tr>
            </thead>
            <tbody>
              {groups.map(({ order, refs }) => [
                <tr key={order.nodeId} className="group">
                  <td colSpan={Math.max(columns.length, 1) + 1}>{order.number} · {order.title}</td>
                </tr>,
                ...refs.map(row),
              ])}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty">
          {search || orderFilter ? "Ничего не найдено."
            : canEdit ? "Правил пока нет. Начните с кнопки «+ Правило»." : "Правил пока нет."}
        </div>
      )}
    </>
  );
}
