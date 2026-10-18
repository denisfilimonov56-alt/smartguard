import { useAuth } from "../../state/auth";
import { useCatalog } from "../../state/catalog";
import { archivedClass, ArchivedBadge, Chip } from "../../ui/common";
import { MenuButton } from "../../ui/Menu";
import { useActions } from "../actions";

/* Словарь :CheckTarget с описаниями: видно, какие правила ссылаются на
   атрибут и у каких нет описания. */

export function TargetsTab() {
  const { targets, showArchivedTargets, reload } = useCatalog();
  const actions = useActions();
  const { canEdit } = useAuth();

  return (
    <section id="tab-targets">
      <div className="page-head">
        <div>
          <h1>Атрибуты</h1>
          <div className="sub">То, что модель ищет в формулировке цели. Атрибут без описания она не распознаёт — правило на нём срабатывает всегда.</div>
        </div>
        {canEdit && <button className="btn primary" onClick={actions.addTarget}>+ Атрибут</button>}
      </div>
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
              <th style={{ width: "24%" }}>Имя</th><th>Описание для модели</th>
              <th style={{ width: "15%" }}>Правила</th><th style={{ width: 70 }} />
            </tr>
          </thead>
          <tbody>
            {targets.map((t) => (
              <tr key={t.nodeId} className={archivedClass(t.status)} data-node={t.nodeId}>
                <td>
                  <span className="mono">{t.name}</span> <ArchivedBadge status={t.status} />
                  {t.source === "job_descriptions" && (
                    <span className="badge" title="Определяется сравнением цели с должностными инструкциями подразделения">
                      по должностным инструкциям
                    </span>
                  )}
                </td>
                <td>{t.description || <span className="badge warn">нет описания — модель не распознает атрибут</span>}</td>
                <td>{t.rules.length
                  ? t.rules.map((r) => <Chip key={r}>{r}</Chip>)
                  : <span className="dim">не используется</span>}</td>
                <td><div className="actions"><MenuButton items={() => actions.targetMenu(t)} /></div></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      ) : <div className="empty">Атрибутов нет. Без них правила не срабатывают.</div>}
    </section>
  );
}
