import { useCallback, useEffect, useState } from "react";

import { api } from "../../api/client";
import type { Diagnostics, Issue } from "../../api/types";
import { useAuth } from "../../state/auth";
import { useCatalog } from "../../state/catalog";
import { Empty, PageHead, Skeleton, Spinner } from "../../ui/common";
import { useDialogs } from "../../ui/Dialogs";
import { errorText, useToast } from "../../ui/Toasts";
import { ExamplesCheck } from "./ExamplesCheck";

/* Что мешает проверкам работать честно. «Показать» ведёт к объекту
   в каталоге с подсветкой. Диагностика перечитывается при каждом входе
   на вкладку. */

const SEVERITY: Record<Issue["severity"], { label: string; cls: string }> = {
  error: { label: "Ошибка", cls: "err" },
  warning: { label: "Предупреждение", cls: "warn" },
  info: { label: "Справочно", cls: "archived" },
};

type LoadState = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; report: Diagnostics };

export function HealthTab() {
  const { goToNode, reload, setHealth } = useCatalog();
  const { confirm } = useDialogs();
  const { isAdmin } = useAuth();
  const toast = useToast();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [repairing, setRepairing] = useState(false);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const report = await api.diagnostics();
      setState({ kind: "ready", report });
      // Значок в меню — из того же отчёта: второй тяжёлый запрос диагностики не нужен.
      setHealth(report.counts);
    } catch (err) {
      setState({ kind: "error", message: errorText(err) });
    }
  }, [setHealth]);

  useEffect(() => { void load(); }, [load]);

  async function repair() {
    const ok = await confirm({
      title: "Проставить идентификаторы?",
      confirmLabel: "Проставить",
      message: <>
        <p>Узлам без <span className="mono">orderId</span> / <span className="mono">clauseId</span> /{" "}
          <span className="mono">ruleId</span> / <span className="mono">exampleId</span> будут присвоены
          значения, выведенные из номера, кода или внутреннего идентификатора.</p>
        <p className="muted">Существующие идентификаторы не меняются. Узлам без{" "}
          <span className="mono">status</span> проставится <span className="mono">active</span>.</p>
      </>,
    });
    if (!ok) return;
    setRepairing(true);
    try {
      const r = await api.repairIdentifiers();
      toast(`Проставлено: приказов ${r.orders}, пунктов ${r.clauses}, `
        + `правил ${r.rules}, примеров ${r.examples}, инструкций ${r.jobDescriptions ?? 0}, статусов ${r.statuses}`, "ok");
      // Имя атрибута и идентификатор подразделения автоматически не выдумываются.
      const manual = [
        r.unnamedTargets?.length ? `атрибутов без имени: ${r.unnamedTargets.length}` : "",
        r.departmentsWithoutId?.length ? `подразделений без идентификатора: ${r.departmentsWithoutId.length}` : "",
      ].filter(Boolean);
      if (manual.length) toast(`Задайте вручную — ${manual.join(", ")}. Их список — в замечаниях ниже.`, "err");
      await reload();
      await load();
    } catch (err) {
      toast(errorText(err), "err");
    } finally {
      setRepairing(false);
    }
  }

  async function mergeDuplicates() {
    const ok = await confirm({
      title: "Свести двойников атрибутов?",
      confirmLabel: "Свести",
      message: <>
        <p>Атрибуты, которые отличаются только написанием (регистр, ё/е, пробелы, кавычки),
          сольются в один: правила и примеры перейдут к оставшемуся, остальные удалятся.</p>
      </>,
    });
    if (!ok) return;
    setRepairing(true);
    try {
      const r = await api.mergeDuplicateTargets();
      const removed = r.merged.reduce((sum, m) => sum + m.removed.length, 0);
      const skipped = r.skipped ?? [];
      toast(r.merged.length ? `Сведено групп: ${r.merged.length}, удалено двойников: ${removed}`
        : skipped.length ? "Сводить автоматически нечего" : "Двойников нет", "ok");
      // Пропущенные группы (например, архивный и действующий атрибут) — с причиной: их решают вручную.
      if (skipped.length) {
        toast(`Не сведено групп: ${skipped.length} — `
          + skipped.map((g) => `${g.names.join(" / ")}: ${g.reason}`).join("; "), "err");
      }
      await reload();
      await load();
    } catch (err) {
      toast(errorText(err), "err");
    } finally {
      setRepairing(false);
    }
  }

  const fixes: Record<string, () => void> = { repair_identifiers: repair, merge_duplicate_targets: mergeDuplicates };

  return (
    <section id="tab-health">
      <PageHead title="Замечания к данным" sub="Что мешает проверкам работать честно. «Показать» ведёт к конкретному объекту.">
        <button className="btn" onClick={() => void load()}>Проверить снова</button>
      </PageHead>
      <div id="healthPanel">
        {state.kind === "loading" && <Skeleton rows={3} label="Проверяем…" />}
        {state.kind === "error" && (
          <div className="card pad">
            <span className="badge warn">API недоступен</span>
            <div className="dim" style={{ marginTop: 8 }}>{state.message}</div>
          </div>
        )}
        {state.kind === "ready" && <Report report={state.report} repairing={repairing} fixes={isAdmin ? fixes : null}
          onGoTo={(nodeId, kind) => void goToNode(nodeId, kind)} />}
      </div>
      <ExamplesCheck onGoTo={(nodeId, kind) => void goToNode(nodeId, kind)} />
    </section>
  );
}

function Report({ report, repairing, fixes, onGoTo }: {
  report: Diagnostics;
  repairing: boolean;
  /** Исправления по fix.action; null — чинить может только администратор. */
  fixes: Record<string, () => void> | null;
  onGoTo: (nodeId: string, kind: Issue["items"][number]["kind"]) => void;
}) {
  return (
    <>
      <div className="card pad" style={{ marginBottom: 16 }}>
        <div className="row" style={{ alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span className={`badge ${report.ready ? "ok" : "err"}`}>
            {report.ready ? "Граф готов к проверкам" : "Граф не готов к проверкам"}
          </span>
          <span className="dim">
            активных атрибутов: {report.check_targets} · ошибок: {report.counts.error} ·
            предупреждений: {report.counts.warning}
          </span>
        </div>
        {!report.ready && (
          <div className="dim" style={{ marginTop: 8 }}>
            Пока есть ошибки, <span className="mono">/ready</span> отдаёт 503: проверка целей
            даёт неполный или неверный результат.
          </div>
        )}
      </div>
      {report.issues.length ? report.issues.map((issue) => {
        const sev = SEVERITY[issue.severity] ?? SEVERITY.info;
        return (
          <div key={issue.code} className={`issue ${issue.severity}`}>
            <h4>
              <span className={`badge ${sev.cls}`}>{sev.label}</span> {issue.title}
              {issue.items.length > 0 && <span className="badge count">{issue.items.length}</span>}
            </h4>
            <div className="detail">{issue.detail}</div>
            {issue.fix && (fixes === null || fixes[issue.fix.action]) && (
              <div style={{ marginTop: 11 }}>
                {fixes ? (
                  <button className="btn sm primary" disabled={repairing} onClick={fixes[issue.fix.action]}>
                    {repairing ? <><Spinner /> Чиним…</> : issue.fix.label}
                  </button>
                ) : <span className="dim">Исправить может администратор.</span>}
              </div>
            )}
            {issue.items.length > 0 && (
              <div className="items">
                {issue.items.map((item, i) => (
                  <div key={i} className="item">
                    <span>{item.label}</span>
                    {item.nodeId && (
                      <button className="btn sm ghost" onClick={() => onGoTo(item.nodeId!, item.kind)}>Показать</button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      }) : <Empty icon="check" title="Замечаний нет">Граф внутренне непротиворечив: проверки работают на полных данных.</Empty>}
    </>
  );
}
