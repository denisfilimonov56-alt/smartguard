import { useState } from "react";

import { api } from "../../api/client";
import type { CheckResult } from "../../api/types";
import { useAuth } from "../../state/auth";
import { useCatalog } from "../../state/catalog";
import { cellState } from "../../state/scope";
import { activeRuleRefs, allRuleRefs } from "../../state/tree";
import { Spinner } from "../../ui/common";
import { Select } from "../../ui/Select";
import { errorText, useToast } from "../../ui/Toasts";
import { useAdviceDialog } from "./AdviceDialog";
import { BatchCheck } from "./BatchCheck";
import { Verdict } from "./Verdict";

/* Главный экран: проверка формулировки цели. Ответ — человеческим языком:
   что не так, какой пункт приказа и как исправить. Справа — что именно
   проверяется для выбранного подразделения и замечания к данным.
   Второй режим — несколько целей сразу, таблицей или из Excel (BatchCheck). */

export function CheckView() {
  const toast = useToast();
  const { orders, departments, health, setSection, setTrace, checkForm, setCheckForm } = useCatalog();
  const { mode, goal, departmentId, result } = checkForm;
  const setGoal = (next: string) => setCheckForm({ goal: next });
  const setDepartmentId = (next: string) => setCheckForm({ departmentId: next });
  const setResult = (next: CheckResult | null) => setCheckForm({ result: next });
  const [busy, setBusy] = useState(false);
  const { canEdit } = useAuth();
  const openAdvice = useAdviceDialog();
  const options = departments.filter((d) => d.departmentId && d.status === "active");
  const department = options.find((d) => d.departmentId === departmentId);

  // Что реально проверяется для подразделения — та же логика, что в графе.
  const active = activeRuleRefs(orders);
  const applicable = active.filter(({ rule }) => !departmentId || cellState(rule, departmentId) !== "off");
  const skipped = active.length - applicable.length;
  const problems = (health?.error ?? 0) + (health?.warning ?? 0);
  // Отметки «✓ / ✕» у правил — по ответу одиночной проверки; у пакета ответ у каждой цели свой.
  const marks = mode === "single" ? result : null;
  const failed = new Set(marks?.violations.map((v) => v.rule_id));

  // Не согласен с ответом по атрибуту — советчик; только редактору и не при сбое проверки.
  const dispute = result && canEdit && result.status !== "NEEDS_MANUAL_REVIEW"
    ? (attribute?: string) => openAdvice({ result, departmentId: departmentId || null, attribute,
      onApplied: () => void run() })
    : undefined;

  async function run() {
    const text = goal.trim();
    if (!text) { toast("Введите формулировку цели", "err"); return; }
    setBusy(true);
    setResult(null);
    try {
      setResult(await api.checkGoal(text, departmentId || null));
    } catch (err) {
      toast(errorText(err), "err");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="tab-check">
      {/* Пакетная проверка занимает всю ширину: боковые карточки относятся к одиночной. */}
      <div className={`check-page ${mode === "batch" ? "batch" : ""}`}>
        <div>
          <div className="seg" id="checkMode" style={{ marginBottom: 14 }}>
            <button type="button" aria-pressed={mode === "single"} onClick={() => setCheckForm({ mode: "single" })}>Одна цель</button>
            <button type="button" aria-pressed={mode === "batch"} onClick={() => setCheckForm({ mode: "batch" })}>Несколько целей</button>
          </div>

          {mode === "batch" ? <BatchCheck /> : (
            <>
              <div className="hero">
                <h1>Проверьте формулировку цели</h1>
                <textarea id="goalInput" aria-label="Формулировка цели" value={goal} onChange={(e) => setGoal(e.target.value)}
                  placeholder="Например: снизить долю просроченных заявок до 5% к 31.12.2025 в рамках проекта «Альфа»" />
                <div className="row wrap" style={{ marginTop: 14 }}>
                  <Select id="departmentInput" ariaLabel="Подразделение" className="pill" value={departmentId}
                    style={{ width: 320 }} onChange={(next) => { setDepartmentId(next); setResult(null); }}
                    options={[{ value: "", label: "Подразделение не указано" },
                      ...options.map((d) => ({ value: d.departmentId!, label: d.name || d.departmentId! }))]} />
                  <button className="btn primary" disabled={busy} onClick={() => void run()}>
                    {busy ? <><Spinner /> Проверяем…</> : "Проверить"}
                  </button>
                </div>
                {!departmentId && (
                  <div className="hint">Без подразделения применяются все правила, включая те, что действуют только в отдельных.</div>
                )}
              </div>

              {dispute && (
                <div className="card pad" id="checkDispute" style={{ marginTop: 16 }}>
                  <div className="row" style={{ gap: 16 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="mid">Ответ по атрибуту должен быть другим?</div>
                      <div className="dim">Опишите, что не так, — модель предложит, как поправить описание атрибута и примеры.</div>
                    </div>
                    <button className="btn sm" style={{ flex: "none" }} onClick={() => dispute()}>Предложить правку графа</button>
                  </div>
                  <div className="alert" style={{ marginTop: 12 }}>
                    Гарантий, что рекомендации модели верны, нет: это черновик, решение остаётся за вами.
                  </div>
                </div>
              )}
              {result && <Verdict result={result} onDispute={dispute}
                onTrace={() => { setTrace(result); setSection("graph"); }} total={applicable.length} />}
              {result && (
                <details className="card pad" id="checkJson" style={{ marginTop: 16 }}>
                  <summary>Ответ API (JSON)</summary>
                  <pre className="mono json">{JSON.stringify(result, null, 2)}</pre>
                </details>
              )}
            </>
          )}
        </div>

        {mode !== "batch" && <aside style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="card pad">
            <h3>Что проверяется{department ? ` для «${department.name || department.departmentId}»` : ""}</h3>
            <div className="small muted" style={{ margin: "4px 0 8px" }}>
              правил: {applicable.length}{skipped ? ` · не для этого подразделения: ${skipped}` : ""}
            </div>
            {applicable.map(({ rule }) => {
              const state = !marks ? "skip" : failed.has(rule.ruleId ?? "") ? "bad" : "good";
              return (
                <div key={rule.nodeId} className="checkline">
                  <span className={`ico sm ${state}`}>{state === "bad" ? "✕" : state === "good" ? "✓" : "–"}</span>
                  <span>{rule.description}</span>
                </div>
              );
            })}
            {!applicable.length && <div className="dim">Правил нет — проверять нечего.</div>}
            <button className="btn sm ghost" style={{ margin: "6px 0 0 -8px" }} onClick={() => setSection("rules")}>Все правила →</button>
          </div>

          {problems > 0 && (
            <div className="card pad">
              <h3>Нужно ваше решение</h3>
              <div className="todo" style={{ marginTop: 10 }}>
                <div className="mid">Замечаний к данным: {problems}</div>
                <button className="btn sm" onClick={() => setSection("health")}>Открыть</button>
                <div className="d">{health?.error ? "Есть ошибки: проверка может давать неверный результат" : "Проверка работает, но данные стоит поправить"}</div>
              </div>
            </div>
          )}

          <div className="card pad navy">
            <h3>Каталог</h3>
            <div className="row" style={{ marginTop: 10, gap: 22 }}>
              <div className="stat"><b>{orders.length}</b><span>приказов</span></div>
              <div className="stat"><b>{allRuleRefs(orders).length}</b><span>правил</span></div>
              <div className="stat"><b>{options.length}</b><span>подразделений</span></div>
            </div>
          </div>
        </aside>}
      </div>
    </section>
  );
}
