import { useCallback, useEffect, useState } from "react";

import { api } from "../../api/client";
import type { ExampleCheckItem, ExamplesCheck as Report, NodeKind } from "../../api/types";
import { useAuth } from "../../state/auth";
import { Spinner } from "../../ui/common";
import { errorText, useToast } from "../../ui/Toasts";

/* Проверка примеров на модели: каждый пример правила уходит в модель как
   настоящая цель, и ответ сравнивается с пометкой примера. Прогон идёт
   в фоне на сервере — пока он не закончился, ход перечитывается. */

const POLL_MS = 1500;

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("ru-RU") : "—");
const names = (list: string[]) => list.map((n) => `«${n}»`).join(", ");
const place = (i: ExampleCheckItem) =>
  [i.ruleId ?? "правило без ruleId", i.order && `приказ ${i.order}`, i.clause && `п. ${i.clause}`]
    .filter(Boolean).join(" · ");

/** Чем ответ модели разошёлся с пометкой примера. */
function explain(i: ExampleCheckItem) {
  const kind = i.isViolation ? "Пример нарушения" : "Корректный пример";
  // Расхождение: на корректном примере правило сработало, на примере нарушения — нет.
  const fired = !i.isViolation;
  const sawAttribute = (i.ruleType === "PROHIBITION") === fired;
  return sawAttribute
    ? `${kind}, но модель нашла в нём ${names(i.found)}`
    : `${kind}, но модель не нашла в нём ${names(i.missing)}`;
}

const GROUPS: { outcome: ExampleCheckItem["outcome"]; severity: string; badge: string; cls: string;
  title: string; detail: string }[] = [
  { outcome: "mismatched", severity: "warning", badge: "Расхождение", cls: "warn",
    title: "Примеры, которые проверка не подтверждает",
    detail: "Модель ответила не так, как помечен пример. Причина — неточное описание атрибута, неверная "
      + "пометка примера или предел модели; настоящие цели с такой формулировкой проверяются так же." },
  { outcome: "failed", severity: "info", badge: "Не проверено", cls: "archived",
    title: "Примеры, которые не удалось проверить",
    detail: "Модель не ответила. Это сбой, а не расхождение: запустите проверку ещё раз." },
  { outcome: "skipped", severity: "info", badge: "Пропущено", cls: "archived",
    title: "Примеры, которые не проверялись",
    detail: "По одному тексту примера эти правила проверить нельзя." },
];

export function ExamplesCheck({ onGoTo }: {
  onGoTo: (nodeId: string, kind: NodeKind) => void;
}) {
  const { canEdit } = useAuth();
  const toast = useToast();
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const load = useCallback(async () => {
    try {
      setReport(await api.examplesCheck());
      setError(null);
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const running = report?.state === "running";
  useEffect(() => {
    if (!running) return;
    const timer = setTimeout(() => void load(), POLL_MS);
    return () => clearTimeout(timer);
  }, [running, report, load]);

  async function start() {
    setStarting(true);
    try {
      setReport(await api.startExamplesCheck());
      setError(null);
    } catch (err) {
      toast(errorText(err), "err");
    } finally {
      setStarting(false);
    }
  }

  const busy = starting || running;
  return (
    <div id="examplesCheck">
      <h2 className="block-title">Проверка примеров на модели</h2>
      <div className="card pad" style={{ marginBottom: 16 }}>
        <div className="row top" style={{ justifyContent: "space-between", gap: 16 }}>
          <div className="muted">
            Каждый пример правила отправляется в модель так же, как настоящая цель: на примере нарушения
            правило должно сработать, на корректном — нет. Запускайте после правки атрибутов и примеров.
          </div>
          {canEdit && (
            <button className="btn primary" disabled={busy} onClick={() => void start()}>
              {busy ? <><Spinner /> Проверяем…</> : "Проверить примеры"}
            </button>
          )}
        </div>
        {error && <div className="dim" style={{ marginTop: 10 }}>Не удалось получить результат: {error}</div>}
        {report && <Summary report={report} />}
      </div>
      {report?.state === "done" && GROUPS.map((group) => {
        const items = report.items.filter((i) => i.outcome === group.outcome);
        if (!items.length) return null;
        return (
          <div key={group.outcome} className={`issue ${group.severity}`} data-outcome={group.outcome}>
            <h4>
              <span className={`badge ${group.cls}`}>{group.badge}</span> {group.title}
              <span className="badge count">{items.length}</span>
            </h4>
            <div className="detail">{group.detail}</div>
            <div className="items">
              {items.map((item) => (
                <div key={`${item.nodeId}:${item.ruleNodeId}`} className="item example">
                  <div>
                    <div>«{item.text}»</div>
                    <div className="dim">
                      {place(item)} — {item.outcome === "mismatched" ? explain(item) : item.reason}
                    </div>
                  </div>
                  <button className="btn sm ghost" onClick={() => onGoTo(item.nodeId, "ViolationExample")}>
                    Показать
                  </button>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Summary({ report }: { report: Report }) {
  if (report.state === "idle")
    return <div className="dim" style={{ marginTop: 10 }}>Проверка ещё не запускалась.</div>;
  if (report.state === "running")
    return (
      <div className="dim" style={{ marginTop: 10 }}>
        <Spinner /> Проверено {report.done} из {report.total || "…"}
      </div>
    );
  if (report.state === "failed")
    return (
      <div className="row" style={{ marginTop: 10, flexWrap: "wrap" }}>
        <span className="badge err">Проверка не выполнена</span>
        <span className="dim">{report.error}</span>
      </div>
    );
  const { matched, mismatched, failed, skipped } = report.counts;
  const total = matched + mismatched + failed + skipped;
  return (
    <div className="row" style={{ marginTop: 10, flexWrap: "wrap" }}>
      {total === 0 ? <span className="badge archived">В каталоге нет действующих примеров</span>
        : mismatched ? <span className="badge warn">Расхождений: {mismatched}</span>
        : failed ? <span className="badge archived">Проверены не все примеры</span>
        : <span className="badge ok">Модель подтверждает примеры</span>}
      {report.stale && <span className="badge warn">Каталог менялся после проверки</span>}
      <span className="dim">
        совпало: {matched} · расхождений: {mismatched} · не проверено: {failed} · пропущено: {skipped} ·{" "}
        {when(report.finishedAt)}{report.startedBy ? `, ${report.startedBy}` : ""}
      </span>
    </div>
  );
}
