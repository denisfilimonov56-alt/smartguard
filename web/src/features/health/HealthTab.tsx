import { useCallback, useEffect, useState } from "react";

import { api } from "../../api/client";
import type { Diagnostics, Issue } from "../../api/types";
import { useAuth } from "../../state/auth";
import { useCatalog } from "../../state/catalog";
import { Spinner } from "../../ui/common";
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
  const { goToNode, reload, refreshHealth } = useCatalog();
  const { confirm } = useDialogs();
  const { isAdmin } = useAuth();
  const toast = useToast();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [repairing, setRepairing] = useState(false);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      setState({ kind: "ready", report: await api.diagnostics() });
    } catch (err) {
      setState({ kind: "error", message: errorText(err) });
    }
    void refreshHealth();
  }, [refreshHealth]);

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
        + `правил ${r.rules}, примеров ${r.examples}, статусов ${r.statuses}`, "ok");
      await reload();
      await load();
    } catch (err) {
      toast(errorText(err), "err");
    } finally {
      setRepairing(false);
    }
  }

  return (
    <section id="tab-health">
      <div className="page-head">
        <div>
          <h1>Замечания к данным</h1>
          <div className="sub">Что мешает проверкам работать честно. «Показать» ведёт к конкретному объекту.</div>
        </div>
        <button className="btn" onClick={() => void load()}>Проверить снова</button>
      </div>
      <div id="healthPanel">
        {state.kind === "loading" && <div className="card pad"><Spinner /> Проверяем…</div>}
        {state.kind === "error" && (
          <div className="card pad">
            <span className="badge warn">API недоступен</span>
            <div className="dim" style={{ marginTop: 8 }}>{state.message}</div>
          </div>
        )}
        {state.kind === "ready" && <Report report={state.report} repairing={repairing} onRepair={isAdmin ? repair : null}
          onGoTo={(nodeId, kind) => void goToNode(nodeId, kind)} />}
      </div>
      <ExamplesCheck onGoTo={(nodeId, kind) => void goToNode(nodeId, kind)} />
    </section>
  );
}

function Report({ report, repairing, onRepair, onGoTo }: {
  report: Diagnostics;
  repairing: boolean;
  /** null — чинить может только администратор. */
  onRepair: (() => void) | null;
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
            {issue.fix?.action === "repair_identifiers" && (
              <div style={{ marginTop: 11 }}>
                {onRepair ? (
                  <button className="btn sm primary" disabled={repairing} onClick={onRepair}>
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
      }) : <div className="empty">Проблем не найдено — граф внутренне непротиворечив.</div>}
    </>
  );
}
