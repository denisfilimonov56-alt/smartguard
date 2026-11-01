import { useMemo } from "react";

import { useAuth } from "../../state/auth";
import { useCatalog } from "../../state/catalog";
import { ruleTexts } from "../../state/tree";
import { ArchivedBadge, archivedClass, attributeTitle, Empty, PageHead, RuleBadge } from "../../ui/common";
import { MenuButton } from "../../ui/Menu";
import { useActions } from "../actions";

/* Словарь :CheckTarget с описаниями: видно, какие правила ссылаются на
   атрибут и у каких нет описания. */

export function TargetsTab() {
  const { targets, orders, showArchivedTargets, reload } = useCatalog();
  const texts = useMemo(() => ruleTexts(orders), [orders]);
  const actions = useActions();
  const { canEdit } = useAuth();

  return (
    <section id="tab-targets">
      <PageHead title="Атрибуты"
        sub="То, что модель ищет в формулировке цели. Атрибут без описания она не распознаёт — правило на нём срабатывает всегда.">
        {canEdit && <button className="btn primary" onClick={actions.addTarget}>+ Атрибут</button>}
      </PageHead>
      <div className="toolbar">
        <label className="check">
          <input type="checkbox" checked={showArchivedTargets}
            onChange={(e) => void reload({ showArchivedTargets: e.target.checked })} /> Архив
        </label>
      </div>
      {targets.length ? (
        <div className="card"><table>
          <thead>
            <tr>
              <th style={{ width: "24%" }}>Название</th><th>Описание для модели</th>
              <th style={{ width: "24%" }}>Правила</th><th style={{ width: 70 }} />
            </tr>
          </thead>
          <tbody>
            {targets.map((t) => (
              <tr key={t.nodeId} className={archivedClass(t.status)} data-node={t.nodeId}>
                <td>
                  <div className="mid">{attributeTitle(t.name)} <ArchivedBadge status={t.status} /></div>
                  <div className="mono dim">{t.name}</div>
                  {t.source === "job_descriptions" && (
                    <span className="badge" title="Определяется сравнением цели с должностными инструкциями подразделения">
                      по должностным инструкциям
                    </span>
                  )}
                </td>
                <td>{t.description || <span className="badge warn">нет описания — модель не распознает атрибут</span>}</td>
                <td>{t.rules.length
                  ? <div className="chips">{t.rules.map((r) => <RuleBadge key={r} code={r} text={texts.get(r)} />)}</div>
                  : <span className="dim">не используется</span>}</td>
                <td><div className="actions"><MenuButton items={() => actions.targetMenu(t)} /></div></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      ) : <Empty icon="list" title="Атрибутов пока нет"
        action={canEdit && <button className="btn primary" onClick={actions.addTarget}>+ Атрибут</button>}>
        Без атрибутов правила не срабатывают: атрибут — это то, что модель ищет в формулировке цели.
      </Empty>}
    </section>
  );
}
