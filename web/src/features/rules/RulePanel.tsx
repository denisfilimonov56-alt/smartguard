import { useEffect, useState } from "react";

import { api } from "../../api/client";
import { useAuth } from "../../state/auth";
import { useCatalog } from "../../state/catalog";
import { scopeOf, withOff, type Scope } from "../../state/scope";
import { findRuleRef } from "../../state/tree";
import { ArchivedBadge, Chip, IdBadge } from "../../ui/common";
import { MenuButton } from "../../ui/Menu";
import { errorText, useToast } from "../../ui/Toasts";
import { useActions } from "../actions";

/* Всё о правиле в одном месте: что проверяем, где действует, примеры. Открывается из матрицы и из текста приказа. */

export function RulePanel() {
  const { orders, targets, departments, panelRule, closeRule, mutate } = useCatalog();
  const actions = useActions();
  const { canEdit, isAdmin } = useAuth();
  const toast = useToast();
  const ref = panelRule ? findRuleRef(orders, panelRule) : undefined;
  const [picking, setPicking] = useState(false);

  // Правило удалили или скрыли вместе с архивом — панели показывать нечего.
  useEffect(() => { if (panelRule && !ref) closeRule(); }, [panelRule, ref, closeRule]);
  useEffect(() => setPicking(false), [panelRule]);
  if (!ref) return null;

  const { order, clause, rule } = ref;
  const scope = scopeOf(rule);
  const known = departments.filter((d) => d.departmentId);
  const limited = scope.length > 0 || picking;

  const save = (next: Scope) =>
    mutate(() => api.setRuleScope(rule.nodeId, next), "Область действия обновлена")
      .catch((err) => toast(errorText(err), "err"));

  function toggle(id: string, checked: boolean) {
    if (checked) {
      void save([...new Set([...scope, id])]);
      return;
    }
    const next = withOff(scope, id, known.map((d) => d.departmentId!));
    if (!next) {
      toast("Должно остаться хотя бы одно подразделение. Чтобы правило действовало везде, выберите «Все подразделения».", "err");
      return;
    }
    void save(next);
  }

  return (
    <aside className="rule-panel" aria-label="Правило">
      <div className="row top between">
        <div className="grow">
          <div className="small dim">Приказ {order.number}, пункт {clause.code}</div>
          <h2 style={{ marginTop: 2 }}>{rule.description || "(без формулировки)"}</h2>
        </div>
        <button className="close-x" aria-label="Закрыть панель" onClick={closeRule}>×</button>
      </div>
      <div className="row">
        {rule.type === "PROHIBITION"
          ? <span className="badge prohibition" title="Этого не должно быть в цели">Запрет</span>
          : <span className="badge requirement" title="Это должно быть в цели">Требование</span>}
        <ArchivedBadge status={rule.status} /><IdBadge value={rule.ruleId} name="ruleId" />
        <div className="spacer" />
        {canEdit && <button className="btn sm" onClick={actions.editRule(rule)}>Изменить</button>}
        <MenuButton items={() => actions.ruleMenu(rule)} />
      </div>
      {rule.checkInstruction && (
        <div className="muted" style={{ fontSize: 13 }}><b>Подсказка автору цели:</b> {rule.checkInstruction}</div>
      )}

      <div className="sec">
        <h3><i>1</i>Что проверяем
          {canEdit && <button className="btn sm ghost" onClick={actions.ruleTargets(rule)}>Изменить</button>}</h3>
        {rule.targets.length ? rule.targets.map((name) => {
          const target = targets.find((t) => t.name === name);
          return (
            <div key={name} className="feature">
              <span className="mono">{name}</span>
              {target?.description
                ? <div className="muted" style={{ fontSize: 13, marginTop: 2 }}>{target.description}</div>
                : target && (
                  <div className="alert row between" style={{ marginTop: 6 }}>
                    <span>Нет описания — модель не распознает атрибут, правило сработает на любой цели</span>
                    {canEdit && <button className="btn sm" onClick={actions.editTarget(target)}>Описать</button>}
                  </div>
                )}
            </div>
          );
        }) : <div className="alert">Нет атрибутов — правило не участвует в проверке</div>}
      </div>

      <div className="sec">
        <h3><i>2</i>Где действует</h3>
        <div className="seg" role="group" aria-label="Где действует">
          <button aria-pressed={!limited} disabled={!canEdit} onClick={() => {
            setPicking(false);
            if (scope.length) void save([]);
          }}>Все подразделения</button>
          <button aria-pressed={limited} disabled={!canEdit} onClick={() => setPicking(true)}>Только выбранные</button>
        </div>
        {limited && (
          <div className="chips" style={{ marginTop: 10 }}>
            {known.map((d) => {
              const on = scope.includes(d.departmentId!);
              return (
                <label key={d.nodeId} className={`box ${on ? "on" : ""}`}>
                  <input type="checkbox" checked={on} disabled={!canEdit}
                    onChange={(e) => toggle(d.departmentId!, e.target.checked)} />
                  {d.name || d.departmentId}
                </label>
              );
            })}
            {!known.length && <span className="dim">Подразделений нет — заведите их в разделе «Подразделения».</span>}
            {canEdit && !scope.length && known.length > 0 && <span className="hint" style={{ margin: 0 }}>Отметьте подразделения</span>}
          </div>
        )}
      </div>

      <div className="sec">
        <h3><i>3</i>Примеры для автора цели</h3>
        {rule.examples.length ? rule.examples.map((ex) => (
          <div key={ex.nodeId} data-node={ex.nodeId}
            className={`example ${ex.isViolation ? "bad" : "good"} ${ex.status === "archived" ? "is-archived" : ""}`}>
            <span className="mark">{ex.isViolation ? "✕" : "✓"}</span>
            <span className="grow">{ex.text} <ArchivedBadge status={ex.status} /></span>
            <MenuButton items={() => [
              { label: "Изменить", run: actions.editExample(ex) },
              { label: "Свойства", run: actions.props(ex.nodeId) },
              ex.status === "archived"
                ? { label: "Вернуть", run: actions.restore(ex.nodeId) }
                : { label: "В архив", run: actions.archive(ex.nodeId) },
              ...(isAdmin ? [{ label: "Удалить", run: actions.deleteExample(ex), danger: true }] : []),
            ]} />
          </div>
        )) : <div className="dim">Примеров нет — автор цели не увидит образца формулировки.</div>}
        {canEdit && (
          <button className="btn sm ghost" style={{ marginLeft: -8, marginTop: 4 }} onClick={actions.addExample(rule)}>
            + Добавить пример
          </button>
        )}
      </div>

      <div className="sec">
        <Chip>{rule.ruleId || "без ruleId"}</Chip>
      </div>
    </aside>
  );
}
