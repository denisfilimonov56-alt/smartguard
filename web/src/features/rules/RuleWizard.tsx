import { useRef, useState } from "react";

import { api } from "../../api/client";
import type { RuleType } from "../../api/types";
import { useAuth } from "../../state/auth";
import { useCatalog, type WizardPreset } from "../../state/catalog";
import { useDraft } from "../../state/drafts";
import { findOrderOf } from "../../state/tree";
import { Chip, Spinner } from "../../ui/common";
import { useDialogs } from "../../ui/Dialogs";
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
  /** Пример уже создан в графе (прошлая попытка): повтор его не создаёт, убрать из мастера нельзя. */
  nodeId?: string;
}

/** Что уже создано прошлой попыткой и с какими значениями: повтор правит созданное, а не плодит дубли. */
interface Created {
  clause?: { nodeId: string; orderNodeId: string; code: string; text: string };
  target?: { nodeId: string; name: string; description: string };
  rule?: string;
}

let draftKey = 0;

/** Мастер целиком — черновик на время повторного входа (state/drafts.ts). */
interface WizardDraft {
  step: number; reached: number;
  orderId: string; newClause: boolean; clauseId: string; code: string; text: string;
  type: RuleType; description: string; instruction: string; picked: string[]; newName: string; newDescription: string;
  limited: boolean; only: string[]; studentsOnly: boolean;
  examples: ExampleDraft[]; exampleText: string; exampleBad: boolean;
  created: Created;
}

export function RuleWizard({ preset }: { preset: WizardPreset }) {
  const toast = useToast();
  const { confirm } = useDialogs();
  const { isAdmin } = useAuth();
  const catalog = useCatalog();
  const { targets, departments, reload, closeWizard, openRule } = catalog;
  // Правило в архивном приказе или пункте не участвует в проверках — их мастер не предлагает.
  const orders = catalog.orders.filter((o) => o.status === "active")
    .map((o) => ({ ...o, clauses: o.clauses.filter((c) => c.status === "active") }));
  const [step, setStep] = useState(preset.clauseNodeId ? 1 : 0);
  const [reached, setReached] = useState(step);
  const [busy, setBusy] = useState(false);

  // Шаг 1
  const [orderId, setOrderId] = useState(
    preset.orderNodeId && orders.some((o) => o.nodeId === preset.orderNodeId) ? preset.orderNodeId : orders[0]?.nodeId ?? "");
  const order = orders.find((o) => o.nodeId === orderId);
  const [newClause, setNewClause] = useState(false);
  const [clauseId, setClauseId] = useState(
    preset.clauseNodeId && order?.clauses.some((c) => c.nodeId === preset.clauseNodeId)
      ? preset.clauseNodeId : order?.clauses[0]?.nodeId ?? "");
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
  const [studentsOnly, setStudentsOnly] = useState(false);

  // Шаг 4
  const [examples, setExamples] = useState<ExampleDraft[]>([]);
  const [exampleText, setExampleText] = useState("");
  const [exampleBad, setExampleBad] = useState(false);

  // Что уже создано: повторная попытка после сбоя не должна плодить дубли
  // и должна учесть исправления, сделанные после сбоя.
  const created = useRef<Created>({});

  // Сессия истекла посреди мастера — после повторного входа он откроется с тем же вводом
  // и с тем, что уже создано прошлой попыткой.
  useDraft<WizardDraft, WizardDraft>("wizard", {
    step, reached, orderId, newClause, clauseId, code, text, type, description, instruction, picked, newName,
    newDescription, limited, only, studentsOnly, examples, exampleText, exampleBad, created: created.current,
  }, (d) => {
    setStep(d.step); setReached(d.reached); setOrderId(d.orderId); setNewClause(d.newClause); setClauseId(d.clauseId);
    setCode(d.code); setText(d.text); setType(d.type); setDescription(d.description); setInstruction(d.instruction);
    setPicked(d.picked); setNewName(d.newName); setNewDescription(d.newDescription); setLimited(d.limited);
    setOnly(d.only); setStudentsOnly(d.studentsOnly);
    setExamples(d.examples.map((e) => ({ ...e, key: ++draftKey })));
    setExampleText(d.exampleText); setExampleBad(d.exampleBad);
    created.current = d.created ?? {};
  }, (d) => {
    // Пустой мастер сохранять незачем.
    const typed = d.code.trim() || d.text.trim() || d.description.trim() || d.instruction.trim() || d.picked.length
      || d.newName.trim() || d.only.length || d.examples.length || d.exampleText.trim() || d.created.rule || d.created.clause;
    return typed ? { ...d, created: { ...d.created } } : undefined;
  });

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

  /** Пункт или атрибут, созданный прошлой попыткой, от которого пользователь потом отказался
      (выбрал существующий пункт, стёр новый атрибут), остался бы в каталоге сиротой: с
      подтверждением он удаляется (администратор) или уходит в архив (редактор). */
  async function dropOrphans(done: Created) {
    const orphans: { nodeId: string; what: string; forget: () => void }[] = [];
    if (done.clause && !useNewClause) {
      const c = done.clause;
      orphans.push({ nodeId: c.nodeId, what: `пункт ${c.code}`, forget: () => { delete done.clause; } });
    }
    if (done.target && !hasNewTarget) {
      const t = done.target;
      orphans.push({ nodeId: t.nodeId, what: `атрибут «${t.name}»`, forget: () => { delete done.target; } });
    }
    if (!orphans.length) return;
    const list = orphans.map((o) => o.what).join(" и ");
    const ok = await confirm({
      title: "Убрать созданное прошлой попыткой?",
      confirmLabel: isAdmin ? "Удалить" : "В архив",
      danger: isAdmin,
      message: <>
        <p>Прошлая попытка успела создать {list}, но в правиле {orphans.length > 1 ? "они" : "он"} теперь
          не {orphans.length > 1 ? "используются" : "используется"}.</p>
        <p className="muted">{isAdmin ? "Удалить навсегда" : "Убрать в архив"}, чтобы в каталоге не осталось лишнего?
          Если оставить — найдёте в «Приказах» и «Атрибутах».</p>
      </>,
    });
    for (const orphan of orphans) {
      if (ok) {
        try {
          await (isAdmin ? api.remove(orphan.nodeId, true) : api.setStatus(orphan.nodeId, "archived"));
        } catch (err) {
          toast(`Не удалось убрать ${orphan.what}: ${errorText(err)}`, "err");
          continue;
        }
      }
      // Оставленный — уже обычный узел каталога: мастер за него больше не отвечает.
      orphan.forget();
    }
  }

  async function submit() {
    for (let i = 0; i < 3; i++) {
      const message = problem(i);
      if (message) { toast(message, "err"); setStep(i); return; }
    }
    setBusy(true);
    const done = created.current;
    try {
      let clauseNodeId = clauseId;
      if (useNewClause) {
        const want = { orderNodeId: orderId, code: code.trim(), text: text.trim() };
        if (!done.clause) {
          done.clause = { nodeId: (await api.createClause(want)).nodeId, ...want };
        } else {
          // Пункт создан прошлой попыткой — переносим и правим его под исправленные поля.
          if (done.clause.orderNodeId !== want.orderNodeId) {
            await api.moveClause(done.clause.nodeId, want.orderNodeId);
            done.clause.orderNodeId = want.orderNodeId;
          }
          if (done.clause.code !== want.code || done.clause.text !== want.text) {
            await api.patch(done.clause.nodeId, { code: want.code, text: want.text });
            Object.assign(done.clause, want);
          }
        }
        clauseNodeId = done.clause.nodeId;
      }

      if (hasNewTarget) {
        const want = { name: newName.trim(), description: newDescription.trim() };
        if (!done.target) {
          done.target = { nodeId: (await api.createTarget(want)).nodeId, ...want };
        } else if (done.target.name !== want.name || done.target.description !== want.description) {
          await api.patch(done.target.nodeId, want);
          Object.assign(done.target, want);
        }
      }
      const ruleTargets = hasNewTarget ? [...picked, newName.trim()] : picked;
      const scope = limited ? only : [];

      if (!done.rule) {
        // Область действия задаётся в той же транзакции, что и правило (RuleCreate.only):
        // правило не может на миг оказаться «для всех».
        const body = {
          clauseNodeId, type, description: description.trim(), checkInstruction: instruction.trim(), targets: ruleTargets,
          studentsOnly, only: scope,
        };
        done.rule = (await api.createRule(body)).nodeId;
      } else {
        // Правило создано прошлой попыткой: приводим его к тому, что сейчас в мастере.
        const rule = done.rule;
        if (findOrderOf(catalog.orders, rule)?.clause?.nodeId !== clauseNodeId) await api.moveRule(rule, clauseNodeId);
        await api.patch(rule, { type, description: description.trim(), checkInstruction: instruction.trim() });
        await api.setRuleTargets(rule, ruleTargets);
        await api.setRuleScope(rule, scope);
        await api.setRuleAudience(rule, studentsOnly);
      }

      for (const example of examples) {
        if (example.nodeId) continue;
        const { nodeId } = await api.createExample({
          ruleNodeId: done.rule, text: example.text, isViolation: example.isViolation,
        });
        example.nodeId = nodeId;
        setExamples((list) => list.map((x) => (x.key === example.key ? { ...x, nodeId } : x)));
      }

      await dropOrphans(done);

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

              <h2 style={{ marginTop: 22 }}>Для кого действует правило?</h2>
              <div className="muted" style={{ marginTop: 4 }}>Кто ставит цель — студент или сотрудник — передаёт запрос проверки.</div>
              <div role="radiogroup" aria-label="Для кого" style={{ marginTop: 6 }}>
                <button type="button" role="radio" aria-checked={!studentsOnly} className="opt"
                  onClick={() => setStudentsOnly(false)}>
                  <i /><span className="t">Для всех</span>
                  <span className="d">Правило проверяется у любой цели</span>
                </button>
                <button type="button" role="radio" aria-checked={studentsOnly} className="opt"
                  onClick={() => setStudentsOnly(true)}>
                  <i /><span className="t">Только для студентов</span>
                  <span className="d">Цели сотрудников по этому правилу проверяться не будут</span>
                </button>
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
                    {ex.nodeId
                      ? <span className="small dim" title="Создан прошлой попыткой; убрать можно в панели правила">сохранён</span>
                      : <button className="btn sm ghost" title="Убрать пример"
                        onClick={() => setExamples((list) => list.filter((x) => x.key !== ex.key))}>✕</button>}
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
              {studentsOnly && <span className="chip blue">только студенты</span>}
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
