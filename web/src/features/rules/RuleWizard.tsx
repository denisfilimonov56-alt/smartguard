import { useRef, useState } from "react";

import { api } from "../../api/client";
import type { RuleType } from "../../api/types";
import { useCatalog, type WizardPreset } from "../../state/catalog";
import { Chip, Spinner } from "../../ui/common";
import { Select } from "../../ui/Select";
import { errorText, useToast } from "../../ui/Toasts";

/* Мастер нового правила. Четыре шага в том порядке, в каком о правиле
   думает владелец приказа: какой пункт → что проверяем → где действует →
   примеры. Справа — что уже заполнено и как нарушение увидит автор цели. */

const STEPS = ["Пункт приказа", "Что проверяем", "Где действует", "Примеры"];

const TYPES: { value: RuleType; title: string; detail: string }[] = [
  { value: "REQUIREMENT", title: "Требование", detail: "Это должно быть в цели. Нарушение — если этого нет" },
  { value: "PROHIBITION", title: "Запрет", detail: "Этого в цели быть не должно. Нарушение — если это есть" },
];

interface ExampleDraft {
  key: number;
  text: string;
  isViolation: boolean;
}

let draftKey = 0;

export function RuleWizard({ preset }: { preset: WizardPreset }) {
  const toast = useToast();
  const { orders, targets, departments, reload, closeWizard, openRule } = useCatalog();
  const [step, setStep] = useState(preset.clauseNodeId ? 1 : 0);
  const [reached, setReached] = useState(step);
  const [busy, setBusy] = useState(false);

  // Шаг 1
  const [orderId, setOrderId] = useState(preset.orderNodeId ?? orders[0]?.nodeId ?? "");
  const order = orders.find((o) => o.nodeId === orderId);
  const [newClause, setNewClause] = useState(false);
  const [clauseId, setClauseId] = useState(preset.clauseNodeId ?? order?.clauses[0]?.nodeId ?? "");
  const [code, setCode] = useState("");
  const [text, setText] = useState("");
  const clause = order?.clauses.find((c) => c.nodeId === clauseId);
  const useNewClause = newClause || !order?.clauses.length;

  // Шаг 2
  const [type, setType] = useState<RuleType>("REQUIREMENT");
  const [description, setDescription] = useState("");
  const [instruction, setInstruction] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const available = targets.filter((t) => t.status !== "archived");
  const hasNewTarget = !!newName.trim();

  // Шаг 3
  const known = departments.filter((d) => d.departmentId && d.status === "active");
  const [limited, setLimited] = useState(false);
  const [only, setOnly] = useState<string[]>([]);

  // Шаг 4
  const [examples, setExamples] = useState<ExampleDraft[]>([]);
  const [exampleText, setExampleText] = useState("");
  const [exampleBad, setExampleBad] = useState(false);

  // Что уже создано: повторная попытка после сбоя не должна плодить дубли.
  const created = useRef<{ clause?: string; target?: boolean; rule?: string; scope?: boolean; examples: number }>({ examples: 0 });

  const label = (id: string) => known.find((d) => d.departmentId === id)?.name || id;
  const clauseCode = useNewClause ? code.trim() : clause?.code ?? "";
  const clauseText = useNewClause ? text.trim() : clause?.text ?? "";

  function problem(at: number): string | null {
    if (at === 0) {
      if (!order) return "Сначала заведите приказ в разделе «Приказы»";
      if (useNewClause ? !code.trim() || !text.trim() : !clause) return "Выберите пункт приказа или заполните новый";
    }
    if (at === 1) {
      if (!description.trim()) return "Сформулируйте правило";
      if (hasNewTarget && !newDescription.trim()) return "Опишите новый атрибут: без описания модель его не распознает";
      if (!picked.length && !hasNewTarget) return "Выберите хотя бы один атрибут или заведите новый — иначе правило не сработает";
    }
    if (at === 2) {
      if (limited && !only.length) return "Отметьте подразделения, в которых действует правило";
    }
    return null;
  }

  function go(next: number) {
    for (let i = step; i < next; i++) {
      const message = problem(i);
      if (message) { toast(message, "err"); setStep(i); return; }
    }
    setStep(next);
    setReached((r) => Math.max(r, next));
  }

  function addExample() {
    if (!exampleText.trim()) { toast("Введите формулировку примера", "err"); return; }
    setExamples((list) => [...list, { key: ++draftKey, text: exampleText.trim(), isViolation: exampleBad }]);
    setExampleText("");
  }

  async function submit() {
    for (let i = 0; i < 3; i++) {
      const message = problem(i);
      if (message) { toast(message, "err"); setStep(i); return; }
    }
    setBusy(true);
    const done = created.current;
    try {
      if (useNewClause && !done.clause)
        done.clause = (await api.createClause({ orderNodeId: orderId, code: code.trim(), text: text.trim() })).nodeId;
      const clauseNodeId = useNewClause ? done.clause! : clauseId;

      if (hasNewTarget && !done.target) {
        await api.createTarget({ name: newName.trim(), description: newDescription.trim() });
        done.target = true;
      }
      const ruleTargets = hasNewTarget ? [...picked, newName.trim()] : picked;

      if (!done.rule)
        done.rule = (await api.createRule({
          clauseNodeId, type, description: description.trim(), checkInstruction: instruction.trim(), targets: ruleTargets,
        })).nodeId;

      if (!done.scope && limited) {
        await api.setRuleScope(done.rule, only);
        done.scope = true;
      }
      for (const example of examples.slice(done.examples)) {
        await api.createExample({ ruleNodeId: done.rule, text: example.text, isViolation: example.isViolation });
        done.examples++;
      }

      toast("Правило создано", "ok");
      const ruleNodeId = done.rule;
      await reload();
      closeWizard();
      openRule(ruleNodeId);
    } catch (err) {
      toast(errorText(err), "err");
      await reload();
      setBusy(false);
    }
  }

  // Требование показывает образец правильной формулировки, запрет — пример нарушения.
  const previewExample = examples.find((e) => e.isViolation === (type === "PROHIBITION"));

  return (
    <div className="wizard">
      <div>
        <div className="small dim">Правила → {order ? `${order.number} · ${order.title}` : "приказ не выбран"}</div>
        <h1 style={{ marginTop: 2 }}>Новое правило</h1>

        <div className="steps">
          {STEPS.map((title, i) => (
            <button key={title} type="button" aria-current={i === step ? "step" : undefined} disabled={i > reached}
              className={`step ${i < step || (i <= reached && i !== step) ? "done" : ""}`}
              onClick={() => (i < step ? setStep(i) : go(i))}>
              <i>{i < step ? "✓" : i + 1}</i>{title}
            </button>
          ))}
        </div>

        <div className="card pad" style={{ padding: "24px 28px" }}>
          {step === 0 && (
            <>
              <h2>К какому пункту приказа относится правило?</h2>
              <div className="field" style={{ marginTop: 16 }}>
                <label htmlFor="wizOrder">Приказ</label>
                <Select id="wizOrder" value={orderId} placeholder="Приказов нет"
                  options={orders.map((o) => ({ value: o.nodeId, label: `${o.number} · ${o.title}` }))}
                  onChange={(next) => {
                    setOrderId(next);
                    setClauseId(orders.find((o) => o.nodeId === next)?.clauses[0]?.nodeId ?? "");
                  }} />
                {!orders.length && <div className="hint">Приказов нет — заведите приказ в разделе «Приказы».</div>}
              </div>
              <div className="seg" role="group" aria-label="Пункт">
                <button aria-pressed={!useNewClause} disabled={!order?.clauses.length} onClick={() => setNewClause(false)}>
                  Существующий пункт
                </button>
                <button aria-pressed={useNewClause} onClick={() => setNewClause(true)}>Новый пункт</button>
              </div>
              {useNewClause ? (
                <div style={{ marginTop: 14 }}>
                  <div className="field">
                    <label htmlFor="wizCode">Номер пункта</label>
                    <input id="wizCode" type="text" value={code} placeholder="3.1" style={{ width: 160 }}
                      onChange={(e) => setCode(e.target.value)} />
                  </div>
                  <div className="field">
                    <label htmlFor="wizText">Текст пункта</label>
                    <textarea id="wizText" value={text} placeholder="Как пункт сформулирован в приказе"
                      onChange={(e) => setText(e.target.value)} />
                  </div>
                </div>
              ) : (
                <div role="radiogroup" aria-label="Пункт приказа" style={{ marginTop: 6 }}>
                  {order?.clauses.map((c) => (
                    <button key={c.nodeId} type="button" role="radio" aria-checked={c.nodeId === clauseId} className="opt"
                      onClick={() => setClauseId(c.nodeId)}>
                      <i /><span className="t">{c.code}</span><span className="d">{c.text}</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}

          {step === 1 && (
            <>
              <h2>Что проверяем в формулировке цели?</h2>
              <div role="radiogroup" aria-label="Тип правила" style={{ marginTop: 8 }}>
                {TYPES.map((t) => (
                  <button key={t.value} type="button" role="radio" aria-checked={type === t.value} className="opt"
                    onClick={() => setType(t.value)}>
                    <i /><span className="t">{t.title}</span><span className="d">{t.detail}</span>
                  </button>
                ))}
              </div>
              <div className="field" style={{ marginTop: 16 }}>
                <label htmlFor="wizDescription">Формулировка правила</label>
                <input id="wizDescription" type="text" value={description}
                  placeholder={type === "PROHIBITION" ? "Цель не должна сводиться к обучению" : "Цель обязана содержать конкретный срок"}
                  onChange={(e) => setDescription(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="wizInstruction">Что подсказать автору цели</label>
                <input id="wizInstruction" type="text" value={instruction}
                  placeholder="Добавьте в формулировку дату или период завершения"
                  onChange={(e) => setInstruction(e.target.value)} />
              </div>
              <div className="field">
                <label>Атрибуты — по ним модель определяет, есть ли это в цели</label>
                <div className="chips">
                  {available.map((t) => {
                    const on = picked.includes(t.name);
                    return (
                      <label key={t.nodeId} className={`box ${on ? "on" : ""}`} title={t.description}>
                        <input type="checkbox" checked={on} onChange={(e) =>
                          setPicked(e.target.checked ? [...picked, t.name] : picked.filter((n) => n !== t.name))} />
                        {t.name}
                      </label>
                    );
                  })}
                  {!available.length && <span className="dim">Атрибутов пока нет — заведите первый ниже.</span>}
                </div>
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="wizNewName">Или новый атрибут</label>
                <div className="row top">
                  <input id="wizNewName" type="text" value={newName} placeholder="имя, например срок_исполнения"
                    style={{ width: 260 }} onChange={(e) => setNewName(e.target.value)} />
                  <input type="text" aria-label="Описание нового атрибута" value={newDescription}
                    placeholder="как понять, что это есть в цели" onChange={(e) => setNewDescription(e.target.value)} />
                </div>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <h2>В каких подразделениях действует правило?</h2>
              <div className="muted" style={{ marginTop: 4 }}>Цели остальных подразделений по этому правилу проверяться не будут.</div>
              <div role="radiogroup" aria-label="Где действует" style={{ marginTop: 6 }}>
                <button type="button" role="radio" aria-checked={!limited} className="opt"
                  onClick={() => { setLimited(false); }}>
                  <i /><span className="t">Во всех подразделениях</span>
                  <span className="d">Правило применяется к любой цели</span>
                </button>
                <div role="radio" aria-checked={limited} className="opt" tabIndex={0}
                  onClick={() => setLimited(true)}>
                  <i /><span className="t">Только в выбранных</span>
                  <span className="d">Отметьте подразделения, для которых приказ вводит это правило</span>
                  {limited && (
                    <div className="inner chips" onClick={(e) => e.stopPropagation()}>
                      {known.map((d) => {
                        const id = d.departmentId!;
                        const on = only.includes(id);
                        return (
                          <label key={d.nodeId} className={`box ${on ? "on" : ""}`}>
                            <input type="checkbox" checked={on} onChange={(e) => {
                              setOnly(e.target.checked ? [...only, id] : only.filter((x) => x !== id));
                            }} />
                            {d.name || id}
                          </label>
                        );
                      })}
                      {!known.length && <span className="dim">Подразделений нет — заведите их в разделе «Подразделения».</span>}
                    </div>
                  )}
                </div>
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <h2>Примеры для автора цели</h2>
              <div className="muted" style={{ marginTop: 4 }}>
                {type === "PROHIBITION"
                  ? "Запрет показывает в ответе примеры нарушений — добавьте хотя бы один."
                  : "Требование показывает в ответе образцы правильных формулировок — добавьте хотя бы один."}
                {" "}Шаг можно пропустить и добавить примеры позже.
              </div>
              <div className="field" style={{ marginTop: 14 }}>
                <label htmlFor="wizExample">Формулировка цели</label>
                <textarea id="wizExample" value={exampleText} onChange={(e) => setExampleText(e.target.value)}
                  placeholder="В рамках проекта «Альфа» разработать API для интеграции до 01.06.2025" />
              </div>
              <div className="row between">
                <div className="seg" role="group" aria-label="Вид примера">
                  <button aria-pressed={!exampleBad} onClick={() => setExampleBad(false)}>✓ Так правильно</button>
                  <button aria-pressed={exampleBad} onClick={() => setExampleBad(true)}>✕ Так нельзя</button>
                </div>
                <button className="btn sm" onClick={addExample}>Добавить пример</button>
              </div>
              <div style={{ marginTop: 12 }}>
                {examples.map((ex) => (
                  <div key={ex.key} className={`example ${ex.isViolation ? "bad" : "good"}`}>
                    <span className="mark">{ex.isViolation ? "✕" : "✓"}</span>
                    <span className="grow">{ex.text}</span>
                    <button className="btn sm ghost" title="Убрать пример"
                      onClick={() => setExamples((list) => list.filter((x) => x.key !== ex.key))}>✕</button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="row between" style={{ marginTop: 18 }}>
          {step > 0
            ? <button className="btn" onClick={() => setStep(step - 1)}>← Назад</button>
            : <button className="btn" onClick={closeWizard}>Отмена</button>}
          <div className="row">
            {step > 0 && <button className="btn ghost" onClick={closeWizard}>Отмена</button>}
            {step < 3
              ? <button className="btn primary" onClick={() => go(step + 1)}>Далее: {STEPS[step + 1].toLowerCase()} →</button>
              : <button className="btn primary" disabled={busy} onClick={() => void submit()}>
                {busy ? <><Spinner /> Создаём…</> : "Создать правило"}
              </button>}
          </div>
        </div>
      </div>

      <aside style={{ display: "flex", flexDirection: "column", gap: 16, marginTop: 8 }}>
        <div className="card pad">
          <h3>Что уже заполнено</h3>
          <div className="sumline" style={{ marginTop: 10 }}>
            <span>Пункт</span>
            <span>{clauseCode ? <><b>{clauseCode}</b> — {clauseText}</> : <span className="dim">не выбран</span>}</span>
          </div>
          <div className="sumline">
            <span>Тип</span>
            <span>{type === "PROHIBITION"
              ? <span className="badge prohibition">Запрет</span> : <span className="badge requirement">Требование</span>}</span>
          </div>
          <div className="sumline">
            <span>Проверяем</span>
            <span>{description.trim() || <span className="dim">ещё не заполнено</span>}
              {(picked.length > 0 || hasNewTarget) && (
                <span className="chips" style={{ marginTop: 6 }}>
                  {[...picked, ...(hasNewTarget ? [newName.trim()] : [])].map((n) => <Chip key={n}>{n}</Chip>)}
                </span>
              )}</span>
          </div>
          <div className="sumline">
            <span>Действует</span>
            <span className="chips">
              {limited
                ? only.length ? only.map((id) => <span key={id} className="chip blue">{label(id)}</span>)
                  : <span className="dim">подразделения не выбраны</span>
                : "Все подразделения"}
            </span>
          </div>
          <div className="sumline">
            <span>Примеры</span>
            <span>{examples.length || <span className="dim">ещё не добавлены</span>}</span>
          </div>
        </div>

        <div className="card pad">
          <h3>Так нарушение увидит автор цели</h3>
          <div className="preview">
            <span className="badge prohibition">Нужно доработать</span>
            <div className="mid" style={{ marginTop: 8, fontSize: 15 }}>{description.trim() || "Формулировка правила"}</div>
            <div className="small muted" style={{ marginTop: 2 }}>
              Приказ {order?.number ?? "…"}, пункт {clauseCode || "…"}
            </div>
            <div className="small" style={{ marginTop: 8 }}>
              <b>Как исправить:</b>{" "}
              {instruction.trim() || <span className="dim">подсказка автору — на шаге «Что проверяем»</span>}
            </div>
            <div className="small" style={{ marginTop: 6 }}>
              <b>{type === "PROHIBITION" ? "Так нельзя:" : "Пример:"}</b>{" "}
              {previewExample ? `«${previewExample.text}»` : <span className="dim">появится после шага «Примеры»</span>}
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}
