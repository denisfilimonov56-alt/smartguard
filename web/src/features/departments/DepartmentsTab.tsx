import type { JobDescriptionRef } from "../../api/types";
import { useAuth } from "../../state/auth";
import { useCatalog } from "../../state/catalog";
import { ArchivedBadge, archivedClass, Chip, Empty, IdBadge, PageHead } from "../../ui/common";
import { MenuButton } from "../../ui/Menu";
import { useActions } from "../actions";

/* Справочник подразделений. Идентификатор — тот, что кадровая система
   передаёт в запросе проверки (department_id). Какие правила действуют
   только здесь и какие здесь не применяются, задаётся у самого правила.
   Здесь же загружаются должностные инструкции: с ними сравнивается цель,
   когда правило стоит на атрибуте, определяемом по инструкциям. */

/** Что сказать о списке обязанностей инструкции рядом с её названием. */
const dutiesNote = (j: JobDescriptionRef) =>
  j.dutiesStatus === "pending" ? " · обязанности выписываются…"
    : j.dutiesStatus === "error" ? " · обязанности не выписаны"
    : !j.duties ? " · нет списка обязанностей" : j.dutiesReviewed ? "" : " · проверьте обязанности";

export function DepartmentsTab() {
  const { departments, showArchivedDepartments, reload } = useCatalog();
  const actions = useActions();
  const { canEdit } = useAuth();

  return (
    <section id="tab-departments">
      <PageHead title="Подразделения"
        sub="Идентификатор передаёт кадровая система в запросе проверки. Где какое правило действует — в разделе «Правила». С должностными инструкциями сравнивается цель подразделения.">
        {canEdit && <button className="btn primary" onClick={actions.addDepartment}>+ Подразделение</button>}
      </PageHead>
      <div className="toolbar">
        <label className="check">
          <input type="checkbox" checked={showArchivedDepartments}
            onChange={(e) => void reload({ showArchivedDepartments: e.target.checked })} /> Архив
        </label>
      </div>
      {departments.length ? (
        <div className="card"><table>
          <thead>
            <tr>
              <th style={{ width: "18%" }}>Идентификатор</th><th>Название</th>
              <th style={{ width: "17%" }}>Только здесь действуют</th>
              <th style={{ width: "26%" }}>Должностные инструкции</th>
              <th style={{ width: 70 }} />
            </tr>
          </thead>
          <tbody>
            {departments.map((d) => (
              <tr key={d.nodeId} className={archivedClass(d.status)} data-node={d.nodeId}>
                <td>
                  <span className="mono">{d.departmentId}</span>{" "}
                  <IdBadge value={d.departmentId} name="departmentId" /><ArchivedBadge status={d.status} />
                </td>
                <td>{d.name || <span className="dim">без названия</span>}</td>
                <td>{d.onlyRules.length
                  ? d.onlyRules.map((r) => <Chip key={r}>{r}</Chip>)
                  : <span className="dim">—</span>}</td>
                <td><div className="chips">
                  {d.jobDescriptions.map((j) => (
                    <span key={j.nodeId} className={archivedClass(j.status)} data-node={j.nodeId}>
                      <MenuButton items={() => actions.jobDescriptionMenu(j)}
                        label={(j.title || "без названия") + dutiesNote(j)} />
                    </span>
                  ))}
                  {canEdit
                    ? <button className="btn sm ghost" onClick={actions.addJobDescription(d)}>+ Инструкция</button>
                    : !d.jobDescriptions.length && <span className="dim">—</span>}
                </div></td>
                <td><div className="actions"><MenuButton items={() => actions.departmentMenu(d)} /></div></td>
              </tr>
            ))}
          </tbody>
        </table></div>
      ) : <Empty icon="list" title="Подразделений пока нет"
        action={canEdit && <button className="btn primary" onClick={actions.addDepartment}>+ Подразделение</button>}>
        Пока их нет, все правила действуют для всех.
      </Empty>}
    </section>
  );
}
