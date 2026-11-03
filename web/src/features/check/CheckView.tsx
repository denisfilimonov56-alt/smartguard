import { useEffect, useMemo, useRef, useState } from "react";

import type { Violation } from "../../api/types";
import { useAuth } from "../../state/auth";
import { useCatalog } from "../../state/catalog";
import { resultMatches, useCheckForm } from "../../state/checkForm";
import { pushRecent, readRecent, type RecentCheck } from "../../state/recent";
import { ruleApplies } from "../../state/scope";
import { activeRuleRefs, allRuleRefs } from "../../state/tree";
import { copyText } from "../../ui/clipboard";
import { Spinner } from "../../ui/common";
import { useDialogs } from "../../ui/Dialogs";
import { useMenu } from "../../ui/Menu";
import { Select } from "../../ui/Select";
import { useToast } from "../../ui/Toasts";
import { useAdviceDialog } from "./AdviceDialog";
import { BatchCheck } from "./BatchCheck";
import { CheckProgress } from "./CheckProgress";
import { JsonDialog } from "./JsonBlock";
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

const STATUS_BADGE: Record<RecentCheck["status"], [string, string]> = {
  ALLOWED: ["ok", "Нарушений нет"],
  VIOLATIONS_FOUND: ["err", "Нужно доработать"],
  NEEDS_MANUAL_REVIEW: ["warn", "Ручная проверка"],
};

/** «сейчас», «12 мин назад», «вчера» или дата — для списка недавних проверок. */
function ago(iso: string) {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (min < 1) return "сейчас";
  if (min < 60) return `${min} мин назад`;
  if (min < 24 * 60) return `${Math.round(min / 60)} ч назад`;
  if (min < 48 * 60) return "вчера";
  return new Date(iso).toLocaleDateString("ru-RU");
}

/** Сколько недавних проверок видно сразу; остальные — по «Вся история». */
const RECENT_SHOWN = 3;

export function CheckView() {
  const { orders, departments, targets, health, setSection, setTrace, goToNode } = useCatalog();
  const { checkForm, setCheckForm, single } = useCheckForm();
  const { mode, goal, departmentId, isStudent } = checkForm;
  // Ответ показывается, только пока он про то, что в форме: формулировку, подразделение
  // и признак студента. После правки любого из них (в том числе пока проверка идёт)
  // старый вердикт и подсветка цитат к новым значениям не относятся; вернули как было — ответ снова виден.
  const result = checkForm.result && resultMatches(checkForm) ? checkForm.result : null;
  const setGoal = (next: string) => setCheckForm({ goal: next });
  const setDepartmentId = (next: string) => { setCheckForm({ departmentId: next }); setFromRecent(false); };
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
  const { canEdit, isAdmin, user } = useAuth();
  const openAdvice = useAdviceDialog();
  const options = departments.filter((d) => d.departmentId && d.status === "active");
  const department = options.find((d) => d.departmentId === departmentId);

  // Недавние проверки этого пользователя (state/recent.ts): ответ записывается, как только пришёл.
  const [recent, setRecent] = useState(() => readRecent(user.login));
  const recorded = useRef(checkForm.result);
  useEffect(() => {
    const r = checkForm.result, sent = checkForm.checked;
    if (!r || !sent || r === recorded.current) return;
    recorded.current = r;
    setRecent(pushRecent(user.login, { goal: sent.goal, departmentId: sent.departmentId, isStudent: sent.isStudent,
      status: r.status, at: new Date().toISOString() }));
  }, [checkForm.result, checkForm.checked, user.login]);
  // Пустая форма берёт подразделение прошлой проверки, если оно ещё действует;
  // только при открытии страницы и появлении справочника, а не при каждом выборе в списке.
  const hasOptions = options.length > 0;
  useEffect(() => {
    const last = recent[0]?.departmentId;
    if (goal || departmentId || !last) return;
    if (options.some((d) => d.departmentId === last)) { setCheckForm({ departmentId: last }); setFromRecent(true); }
  }, [hasOptions]);
  const [fromRecent, setFromRecent] = useState(false);
  // Недавних показывается три; «Вся история» раскрывает остальные сохранённые.
  const [allRecent, setAllRecent] = useState(false);
  const repeat = (r: RecentCheck) => {
    setCheckForm({ goal: r.goal, departmentId: r.departmentId, isStudent: r.isStudent });
    setEditing(false);
    void single.run(r.goal, r.departmentId, r.isStudent);
  };

  // Что реально проверяется для подразделения и студента — та же логика, что в графе.
  const active = useMemo(() => activeRuleRefs(orders), [orders]);
  const applicable = active.filter(({ rule }) => ruleApplies(rule, departmentId || null, isStudent));
  const skippedByDepartment = active.filter(({ rule }) => !ruleApplies(rule, departmentId || null, true)).length;
  const skippedForStudents = active.length - applicable.length - skippedByDepartment;
  const problems = (health?.error ?? 0) + (health?.warning ?? 0);
  // Отметки «✓ / ✕» у правил — по ответу одиночной проверки; у пакета ответ у каждой цели свой.
  // При ручной проверке ✓ не ставится никому: ненарушенное правило там не значит выполненное.
  // Правила, которые API проверить не смог (unverified_rule_node_ids), — «не проверено» и при другом статусе.
  const marks = mode === "single" ? result : null;
  const failed = useMemo(() => failedRules(marks?.violations ?? []), [marks]);
  const unverified = useMemo(() => new Set(marks?.unverified_rule_node_ids ?? []), [marks]);
  const manual = marks?.status === "NEEDS_MANUAL_REVIEW";

  // Не согласен с ответом по атрибуту — советчик; только редактору и не при сбое проверки.
  const dispute = result && canEdit && result.status !== "NEEDS_MANUAL_REVIEW"
    ? (attribute?: string) => openAdvice({ result, departmentId: departmentId || null, attribute,
      onApplied: () => void run() })
    : undefined;

  const toast = useToast();
  const openMenu = useMenu();
  const { openCustom } = useDialogs();
  const jsonMenu = result && isAdmin ? (
    <button className="btn sm menu-btn" id="checkMenu" aria-haspopup="menu" aria-label="Ещё" title="Ещё"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => openMenu(e.currentTarget, [
        { label: "Показать ответ API (JSON)", run: () => openCustom((close) => <JsonDialog id="checkJson" value={result} close={close} />) },
        { label: "Скопировать ответ API (JSON)", run: async () => {
          if (await copyText(JSON.stringify(result, null, 2))) toast("JSON скопирован", "ok");
          else toast("Не удалось скопировать — откройте ответ API и скопируйте вручную", "err");
        } },
      ])}>⋯</button>
  ) : undefined;

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
                    options={[{ value: "", label: "Выберите подразделение" },
                      ...options.map((d) => ({ value: d.departmentId!, label: d.name || d.departmentId! }))]} />
                  <label className="check" title="Часть правил действует только для целей студентов">
                    <input type="checkbox" id="studentInput" checked={isStudent}
                      onChange={(e) => setIsStudent(e.target.checked)} />
                    Цель ставит студент
                  </label>
                  <div className="spacer" />
                  <button className="btn primary" disabled={busy || !departmentId} onClick={() => void run()}
                    title={departmentId ? undefined : "Сначала выберите подразделение"}>
                    {busy ? <><Spinner /> Проверяем…</> : "Проверить"}
                  </button>
                </div>
                {!departmentId && (
                  <div className="hint">Выберите подразделение — без него проверка не запускается.</div>
                )}
                {departmentId && fromRecent && <div className="hint">Подразделение — с прошлой проверки.</div>}
              </div>

              {(busy || result) && <CheckProgress progress={single.progress} busy={busy} />}
              {/* Сначала вердикт и нарушения; «Не согласен» — у каждого нарушения (Verdict). */}
              {result && (
                <Verdict result={result} onDispute={dispute} onAttribute={openAttribute} menu={jsonMenu}
                  onTrace={() => { setTrace(result); setSection("graph"); }} total={applicable.length} />
              )}
              {recent.length > 0 && (
                <div className="card pad recent" id="checkRecent">
                  <div className="row recent-head">
                    <h3>Недавние проверки</h3>
                    <div className="spacer" />
                    {recent.length > RECENT_SHOWN && (
                      <button type="button" className="btn sm ghost" onClick={() => setAllRecent(!allRecent)}>
                        {allRecent ? "Свернуть" : `Вся история (${recent.length}) →`}</button>
                    )}
                  </div>
                  {(allRecent ? recent : recent.slice(0, RECENT_SHOWN)).map((r) => (
                    <div key={r.at} className="recent-row">
                      <span className="recent-goal" title={r.goal}>{r.goal}</span>
                      <span className={`badge ${STATUS_BADGE[r.status][0]}`}>{STATUS_BADGE[r.status][1]}</span>
                      <span className="dim">{ago(r.at)}</span>
                      <button type="button" className="btn sm ghost" disabled={busy} onClick={() => repeat(r)}>Повторить</button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {mode !== "batch" && <aside style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="card pad">
            <h3>Что проверяется{department ? ` для «${department.name || department.departmentId}»` : ""}</h3>
            <div className="chips counts">
              <span className="badge requirement">применимо {applicable.length} из {active.length}</span>
              {skippedByDepartment > 0 && <span className="badge">не для этого подразделения: {skippedByDepartment}</span>}
              {skippedForStudents > 0 && <span className="badge">только для студентов: {skippedForStudents}</span>}
            </div>
            {applicable.map(({ rule }) => {
              const state = !marks ? "skip" : failed(rule) ? "bad"
                : manual || unverified.has(rule.nodeId) ? "unknown" : "good";
              return (
                <div key={rule.nodeId} className="checkline" data-state={state}>
                  <span className={`ico sm ${state}`} title={state === "unknown" ? "Не проверено: нужна ручная проверка" : undefined}>
                    {state === "bad" ? "✕" : state === "good" ? "✓" : state === "unknown" ? "?" : "–"}</span>
                  <span>{rule.description}{state === "unknown" && <span className="dim"> · не проверено</span>}</span>
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
