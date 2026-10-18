import { useState } from "react";

import type { Clause, Order, Rule } from "../../api/types";
import { useAuth } from "../../state/auth";
import { useCatalog } from "../../state/catalog";
import { scopeSummary } from "../../state/scope";
import { normalizeQuery, orderMatches } from "../../state/tree";
import { archivedClass, ArchivedBadge, Chip, IdBadge } from "../../ui/common";
import { MenuButton } from "../../ui/Menu";
import { useActions } from "../actions";

/* Приказ читается как документ: пункт, под ним правила простыми словами.
   Слева — список приказов, клик по правилу открывает его панель. */

export function OrdersView() {
  const { orders, showArchived, reload, selectedOrder, selectOrder } = useCatalog();
  const actions = useActions();
  const { canEdit } = useAuth();
  const [search, setSearch] = useState("");
  const query = normalizeQuery(search);
  const visible = orders.filter((o) => orderMatches(o, query));
  // Если выбранного приказа нет в списке (удалён, скрыт архивом или ещё не
  // дочитан после создания), показываем первый, но сам выбор не трогаем.
  const order = visible.find((o) => o.nodeId === selectedOrder) ?? visible[0];

  return (
    <section id="tab-orders">
      <div className="orders">
        <div>
          <input type="search" className="pill" placeholder="Поиск по приказам…" value={search}
            onChange={(e) => setSearch(e.target.value)} />
          <div className="row between" style={{ margin: "16px 6px 2px" }}>
            <span className="small mid muted">ПРИКАЗЫ</span>
            <label className="check small">
              <input type="checkbox" checked={showArchived}
                onChange={(e) => void reload({ showArchived: e.target.checked })} /> Архив
            </label>
          </div>
          <div role="listbox" aria-label="Приказы">
            {visible.map((o) => (
              <button key={o.nodeId} role="option" aria-selected={o.nodeId === order?.nodeId}
                className={`order-item ${archivedClass(o.status)}`} onClick={() => selectOrder(o.nodeId)}>
                <div className="n">{o.number || "(без номера)"}</div>
                <div className="mid">{o.title}</div>
                <div className="small dim" style={{ marginTop: 4 }}>
                  {o.clauses.length} п. · {o.clauses.reduce((n, c) => n + c.rules.length, 0)} прав.
                </div>
              </button>
            ))}
          </div>
          {!visible.length && <div className="dim" style={{ padding: "12px 14px" }}>{search ? "Ничего не найдено." : "Приказов пока нет."}</div>}
          {canEdit && <button className="btn ghost" style={{ marginTop: 10 }} onClick={actions.addOrder}>+ Добавить приказ</button>}
        </div>

        {order ? <OrderDocument order={order} /> : (
          <div className="empty">{search ? "Ничего не найдено."
            : canEdit ? "Приказов пока нет. Начните с кнопки «+ Добавить приказ»." : "Приказов пока нет."}</div>
        )}
      </div>
    </section>
  );
}

function OrderDocument({ order }: { order: Order }) {
  const actions = useActions();
  const { canEdit } = useAuth();
  return (
    <div data-node={order.nodeId} className={archivedClass(order.status)} style={{ borderRadius: 16 }}>
      <div className="row top between">
        <div className="grow">
          <div className="small dim">{order.date ? `Приказ от ${order.date}` : "Приказ"}</div>
          <h1>{order.number || "(без номера)"} · {order.title}</h1>
          <div className="row" style={{ marginTop: 6 }}>
            <IdBadge value={order.orderId} name="orderId" /><ArchivedBadge status={order.status} />
          </div>
        </div>
        <div className="row">
          {canEdit && <button className="btn sm" onClick={actions.editOrder(order)}>Изменить</button>}
          <MenuButton items={() => actions.orderMenu(order)} />
        </div>
      </div>

      {order.clauses.map((c) => <ClauseBlock key={c.nodeId} clause={c} />)}
      {!order.clauses.length && <div className="dim" style={{ marginTop: 18 }}>Пунктов нет.</div>}
      {canEdit && (
        <button className="btn ghost" style={{ margin: "18px 0 0 54px" }} onClick={actions.addClause(order.nodeId)}>
          + Добавить пункт
        </button>
      )}
    </div>
  );
}

function ClauseBlock({ clause }: { clause: Clause }) {
  const actions = useActions();
  const { canEdit } = useAuth();
  return (
    <div className={`clause ${archivedClass(clause.status)}`} data-node={clause.nodeId}>
      <div className="num">{clause.code || "?"}</div>
      <div className="text">
        {clause.text}{" "}
        <IdBadge value={clause.clauseId} name="clauseId" /><ArchivedBadge status={clause.status} />
        {clause.references.length > 0 && (
          <span className="chips" style={{ marginTop: 6 }}>
            <span className="dim">ссылается на:</span>
            {clause.references.map((r) => <Chip key={r.nodeId}>→ {r.code}</Chip>)}
          </span>
        )}
      </div>
      <MenuButton items={() => actions.clauseMenu(clause)} />
      <div className="under">
        {clause.rules.map((r) => <RuleCard key={r.nodeId} rule={r} />)}
        {!clause.rules.length && <div className="dim">Правил нет — пункт ничего не проверяет.</div>}
        {canEdit && <button className="btn sm ghost" style={{ alignSelf: "flex-start" }} onClick={actions.addRule(clause)}>+ Правило</button>}
      </div>
    </div>
  );
}

function RuleCard({ rule }: { rule: Rule }) {
  const { openRule, panelRule } = useCatalog();
  return (
    <button className={`rule-card ${archivedClass(rule.status)}`} data-node={rule.nodeId}
      aria-current={panelRule === rule.nodeId} onClick={() => openRule(rule.nodeId)}>
      <div className="row wrap">
        {rule.type === "PROHIBITION"
          ? <span className="badge prohibition">Запрет</span>
          : <span className="badge requirement">Требование</span>}
        <span className="what grow">{rule.description || "(без формулировки)"}</span>
        <span className="small dim">{rule.examples.length ? `примеров: ${rule.examples.length}` : "нет примеров"}</span>
      </div>
      <div className="meta">
        {scopeSummary(rule)}
        <IdBadge value={rule.ruleId} name="ruleId" /><ArchivedBadge status={rule.status} />
        {!rule.targets.length && <span className="badge warn">нет атрибутов — правило не сработает</span>}
      </div>
    </button>
  );
}
