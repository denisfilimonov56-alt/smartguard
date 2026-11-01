import { useState } from "react";

import { api, isStale, STALE_TEXT } from "../../api/client";
import type { Department, Rule } from "../../api/types";
import { useAuth } from "../../state/auth";
import { useCatalog } from "../../state/catalog";
import {
  allDepartmentIds, cellState, FUTURE_DEPARTMENTS_HINT, scopeOf, withApplies, withOff, type CellState,
} from "../../state/scope";
import { allRuleRefs, normalizeQuery, ruleMatches, type RuleRef } from "../../state/tree";
import { ArchivedBadge, Empty, PageHead } from "../../ui/common";
import { Select } from "../../ui/Select";
import { errorText, useToast } from "../../ui/Toasts";
import { useActions } from "../actions";
import { RuleWizard } from "./RuleWizard";

/* Главный рабочий экран владельца приказа: строка — правило, столбец —
   подразделение. В ячейке сразу видно, действует ли правило, и там же
   это меняется. Клик по названию правила открывает его панель. */

const STATE_LABEL: Record<CellState, string> = { applies: "действует", off: "не действует" };

const Cell = ({ state }: { state: CellState }) =>
  state === "applies" ? <span className="cell yes">✓</span> : <span className="cell no">✕</span>;

export function RulesView() {
  const { wizard } = useCatalog();
  return (
    <section id="tab-rules">
      {wizard ? <RuleWizard preset={wizard} /> : <Matrix />}
    </section>
  );
}

function Matrix() {
  const { orders, departments, showArchived, reload, openRule, openWizard, panelRule, savingRule } = useCatalog();
  const actions = useActions();
  const { canEdit } = useAuth();
  const toast = useToast();
  const [toggling, setToggling] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [orderFilter, setOrderFilter] = useState("");
  const [focus, setFocus] = useState<string | null>(null);
  const query = normalizeQuery(search);

  const columns = departments.filter((d) => d.departmentId);
  const groups = orders
    .filter((o) => !orderFilter || o.nodeId === orderFilter)
    .map((order) => ({ order, refs: allRuleRefs([order]).filter((ref) => ruleMatches(ref, query)) }))
    .filter((g) => g.refs.length);
  /** Щелчок по ячейке сразу переключает правило для подразделения; «Отменить» в уведомлении возвращает как было. */
  async function toggle(rule: Rule, department: Department) {
    const key = rule.nodeId + department.nodeId;
    const departmentId = department.departmentId!;
    const name = department.name || departmentId;
    const scope = scopeOf(rule);
    const turnOn = cellState(rule, departmentId) === "off";
    setFocus(key);
    setToggling(key);
    try {
      // У правила «для всех» список берётся полный, с архивными подразделениями.
      const next = turnOn ? withApplies(scope, departmentId)
        : withOff(scope, departmentId, scope.length ? [] : await allDepartmentIds());
      if (!next) {
        toast("Правило должно действовать хотя бы в одном подразделении. Если оно больше не нужно — отправьте его в архив.", "err");
        return;
      }
      // expected — область, от которой посчитан новый список: чужое изменение не перезаписывается (409).
      await api.setRuleScope(rule.nodeId, next, scope);
      await reload();
      const what = `«${rule.description || "Правило"}» ${turnOn ? "теперь действует" : "больше не действует"} для «${name}»`;
      toast(!turnOn && !scope.length ? `${what}. ${FUTURE_DEPARTMENTS_HINT}` : what, "ok", {
        label: "Отменить",
        run: () => void api.setRuleScope(rule.nodeId, scope, next).then(() => reload(),
          (err) => toast(isStale(err) ? STALE_TEXT : errorText(err), "err")),
      });
    } catch (err) {
      toast(isStale(err) ? STALE_TEXT : errorText(err), "err");
      if (isStale(err)) await reload();
    } finally {
      setToggling(null);
    }
  }

  const row = ({ clause, rule }: RuleRef) => (
    <tr key={rule.nodeId} data-node={rule.nodeId} className={`${panelRule === rule.nodeId ? "selected" : ""}`}>
      <td className={`rule-col ${rule.status === "archived" ? "is-archived" : ""}`} onClick={() => openRule(rule.nodeId)}>
        <div className="t">{rule.description || "(без формулировки)"}</div>
        <div className="s">
          п. {clause.code || "?"} · {rule.type === "PROHIBITION" ? "запрет" : "требование"}
          <ArchivedBadge status={rule.status} />
          {rule.studentsOnly && <span className="badge requirement" title="Проверяется только у целей студентов">только студенты</span>}
          {!rule.targets.length && <span className="badge warn">нет атрибутов — не сработает</span>}
        </div>
      </td>
      {columns.map((d) => {
        const state = cellState(rule, d.departmentId!);
        const key = rule.nodeId + d.nodeId;
        return (
          <td key={d.nodeId}>
            <button className={`cell-btn ${focus === key ? "focus" : ""}`} data-state={state}
              disabled={!canEdit || savingRule === rule.nodeId || toggling === key}
              title={savingRule === rule.nodeId || toggling === key ? "Сохраняется…" : canEdit ? "Щелчок переключает" : undefined}
              aria-label={`${rule.description} — ${d.name || d.departmentId}: ${STATE_LABEL[state]}`}
              onClick={() => void toggle(rule, d)} onBlur={() => setFocus(null)}>
              <Cell state={state} />
            </button>
          </td>
        );
      })}
    </tr>
  );

  return (
    <>
      <PageHead title="Где какое правило действует"
        sub={<>Строка — правило из приказа, столбец — подразделение.{canEdit && " Щелчок по отметке переключает её."}</>}>
        {canEdit && <button className="btn" onClick={actions.addDepartment}>+ Подразделение</button>}
        {canEdit && <button className="btn primary" onClick={() => openWizard()}>+ Правило</button>}
      </PageHead>

      <div className="toolbar">
        <Select className="pill" style={{ width: 230 }} ariaLabel="Приказ" value={orderFilter} onChange={setOrderFilter}
          options={[{ value: "", label: "Все приказы" },
            ...orders.map((o) => ({ value: o.nodeId, label: o.number || o.orderId || "(без номера)" }))]} />
        <label className="check">
          <input type="checkbox" checked={showArchived}
            onChange={(e) => void reload({ showArchived: e.target.checked })} /> Архив
        </label>
        <input type="search" className="pill grow" placeholder="Поиск по правилам…" value={search}
          onChange={(e) => setSearch(e.target.value)} />
        <div className="legend">
          <span><span className="cell yes mini">✓</span>действует</span>
          <span><span className="cell no mini">✕</span>не действует</span>
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
        search || orderFilter
          ? <Empty icon="search" title="Ничего не найдено">Измените запрос или снимите фильтр по приказу.</Empty>
          : <Empty icon="list" title="Правил пока нет"
            action={canEdit && <button className="btn primary" onClick={() => openWizard()}>+ Правило</button>}>
            Правило — требование или запрет из пункта приказа, который проверяется в формулировке цели.
          </Empty>
      )}
    </>
  );
}
