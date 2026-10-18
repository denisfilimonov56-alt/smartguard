import { useMemo, useState } from "react";

import type { Violation } from "../../api/types";
import { useAuth } from "../../state/auth";
import { useCatalog } from "../../state/catalog";
import { resultMatches, useCheckForm } from "../../state/checkForm";
import { ruleApplies } from "../../state/scope";
import { activeRuleRefs, allRuleRefs } from "../../state/tree";
import { Spinner } from "../../ui/common";
import { Select } from "../../ui/Select";
import { useAdviceDialog } from "./AdviceDialog";
import { BatchCheck } from "./BatchCheck";
import { JsonBlock } from "./JsonBlock";
import { Verdict } from "./Verdict";

/* Главный экран: проверка формулировки цели. Ответ — человеческим языком:
   что не так, какой пункт приказа и как исправить. Справа — что именно
   проверяется для выбранного подразделения и замечания к данным.
   Второй режим — несколько целей сразу, таблицей или из Excel (BatchCheck). */

/** Формулировка цели с подсветкой фрагментов, по которым модель нашла атрибуты; фрагмент открывает атрибут.
    При наведении над фрагментом всплывает бейдж с названием атрибута (styles.css: mark.hl::after). */
function GoalText({ goal, quotes, onAttribute }: {
  goal: string; quotes?: Record<string, string>; onAttribute?: (attribute: string) => void;
}) {
  const found = Object.entries(quotes ?? {}).filter(([, q]) => q && goal.includes(q))
    .map(([attribute, q]) => ({ attribute, at: goal.indexOf(q), len: q.length }))
    .sort((a, b) => a.at - b.at);
  const parts: React.ReactNode[] = [];
  let pos = 0;
  for (const f of found) {
    if (f.at < pos) continue;
    parts.push(goal.slice(pos, f.at));
    parts.push(
      <mark key={f.at} className={`hl ${onAttribute ? "link" : ""}`} aria-label={`Атрибут: ${f.attribute}`}
        role={onAttribute ? "button" : undefined} tabIndex={onAttribute ? 0 : undefined} data-attribute={f.attribute}
        onClick={onAttribute ? () => onAttribute(f.attribute) : undefined}
        onKeyDown={onAttribute ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onAttribute(f.attribute); } } : undefined}>
        {goal.slice(f.at, f.at + f.len)}
      </mark>,
    );
    pos = f.at + f.len;
  }
  parts.push(goal.slice(pos));
  return <>{parts}</>;
}

/** Правила, нарушенные в ответе: по nodeId правила, а у ответа без него — по ruleId или тексту. */
function failedRules(violations: Violation[]) {
  const nodes = new Set<string>(), ids = new Set<string>(), texts = new Set<string>();
  for (const v of violations) {
    if (v.rule_node_id) nodes.add(v.rule_node_id);
    else if (v.rule_id) ids.add(v.rule_id);
    else if (v.rule_text) texts.add(v.rule_text);
  }
  return (rule: { nodeId: string; ruleId?: string | null; description?: string | null }) =>
    nodes.has(rule.nodeId) || (!!rule.ruleId && ids.has(rule.ruleId)) || (!!rule.description && texts.has(rule.description));
}

export function CheckView() {
  const { orders, departments, targets, health, setSection, setTrace, goToNode } = useCatalog();
  const { checkForm, setCheckForm, single } = useCheckForm();
  const { mode, goal, departmentId, isStudent } = checkForm;
  // Ответ показывается, только пока он про то, что в форме: формулировку, подразделение
  // и признак студента. После правки любого из них (в том числе пока проверка идёт)
  // старый вердикт и подсветка цитат к новым значениям не относятся; вернули как было — ответ снова виден.
  const result = checkForm.result && resultMatches(checkForm) ? checkForm.result : null;
  const setGoal = (next: string) => setCheckForm({ goal: next });
  const setDepartmentId = (next: string) => setCheckForm({ departmentId: next });
  const setIsStudent = (next: boolean) => setCheckForm({ isStudent: next });
  const busy = single.busy;
  // После ответа поле ввода сменяется формулировкой с подсветкой найденного; «Изменить» возвращает поле.
  const [editing, setEditing] = useState(false);
  const compact = mode === "single" && !!result && !editing;
  // Найденный атрибут открывается в словаре; если узла с таким именем нет — просто раздел.
  const openAttribute = (name: string) => {
    const target = targets.find((t) => t.name === name);
    if (target) void goToNode(target.nodeId, "CheckTarget");
    else setSection("targets");
  };
  const { canEdit } = useAuth();
  const openAdvice = useAdviceDialog();
  const options = departments.filter((d) => d.departmentId && d.status === "active");
  const department = options.find((d) => d.departmentId === departmentId);

  // Что реально проверяется для подразделения и студента — та же логика, что в графе.
  const active = useMemo(() => activeRuleRefs(orders), [orders]);
  const applicable = active.filter(({ rule }) => ruleApplies(rule, departmentId || null, isStudent));
  const skippedByDepartment = active.filter(({ rule }) => !ruleApplies(rule, departmentId || null, true)).length;
  const skippedForStudents = active.length - applicable.length - skippedByDepartment;
  const problems = (health?.error ?? 0) + (health?.warning ?? 0);
  // Отметки «✓ / ✕» у правил — по ответу одиночной проверки; у пакета ответ у каждой цели свой.
  const marks = mode === "single" ? result : null;
  const failed = useMemo(() => failedRules(marks?.violations ?? []), [marks]);

  // Не согласен с ответом по атрибуту — советчик; только редактору и не при сбое проверки.
  const dispute = result && canEdit && result.status !== "NEEDS_MANUAL_REVIEW"
    ? (attribute?: string) => openAdvice({ result, departmentId: departmentId || null, attribute,
      onApplied: () => void run() })
    : undefined;

  // Повторный запуск, пока идёт проверка (Ctrl+Enter, советчик), запроса не шлёт: см. state/checkForm.tsx.
  async function run() {
    if (await single.run(goal, departmentId, isStudent)) setEditing(false);
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
                {compact ? (
                  <div className="goal-view" id="goalSummary">
                    <div className="goal-text"><GoalText goal={result?.goal ?? goal} quotes={result?.attribute_quotes} onAttribute={openAttribute} /></div>
                    <button type="button" className="btn sm ghost" onClick={() => setEditing(true)}>Изменить</button>
                  </div>
                ) : (
                  <textarea id="goalInput" aria-label="Формулировка цели" value={goal} onChange={(e) => setGoal(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (!busy) void run(); } }}
                    placeholder="Например: снизить долю просроченных заявок до 5% к 31.12.2025 в рамках проекта «Альфа»" />
                )}
                <div className="row wrap" style={{ marginTop: 14 }}>
                  <Select id="departmentInput" ariaLabel="Подразделение" className="pill" value={departmentId}
                    style={{ width: 320 }} onChange={setDepartmentId}
                    options={[{ value: "", label: "Подразделение не указано" },
                      ...options.map((d) => ({ value: d.departmentId!, label: d.name || d.departmentId! }))]} />
                  <label className="check" title="Часть правил действует только для целей студентов">
                    <input type="checkbox" id="studentInput" checked={isStudent}
                      onChange={(e) => setIsStudent(e.target.checked)} />
                    Цель ставит студент
                  </label>
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
                </div>
              )}
              {result && <Verdict result={result} onDispute={dispute} onAttribute={openAttribute}
                onTrace={() => { setTrace(result); setSection("graph"); }} total={applicable.length} />}
              {result && <JsonBlock id="checkJson" value={result} />}
            </>
          )}
        </div>

        {mode !== "batch" && <aside style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="card pad">
            <h3>Что проверяется{department ? ` для «${department.name || department.departmentId}»` : ""}</h3>
            <div className="small muted" style={{ margin: "4px 0 8px" }}>
              правил: {applicable.length}{skippedByDepartment ? ` · не для этого подразделения: ${skippedByDepartment}` : ""}
              {skippedForStudents ? ` · только для студентов: ${skippedForStudents}` : ""}
            </div>
            {applicable.map(({ rule }) => {
              const state = !marks ? "skip" : failed(rule) ? "bad" : "good";
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
