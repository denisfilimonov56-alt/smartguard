import { useState } from "react";

import { api } from "../../api/client";
import type { Advice, AdviceExample, CheckResult } from "../../api/types";
import { useCatalog } from "../../state/catalog";
import { Spinner } from "../../ui/common";
import { Overlay, useDialogs } from "../../ui/Dialogs";
import { Select } from "../../ui/Select";
import { errorText, useToast } from "../../ui/Toasts";

/* Советчик по графу: редактор не согласен с ответом проверки по одному
   атрибуту и объясняет почему. Модель предлагает новое описание атрибута,
   API проверяет его на этой цели и на примерах каталога. Граф меняется только
   кнопками «Применить» и «Добавить» — обычной правкой узла и созданием примера. */

interface Props {
  result: CheckResult;
  departmentId: string | null;
  /** Атрибут, с ответом по которому не согласны; иначе его выбирают в окне. */
  attribute?: string;
  /** Граф поправили: проверку стоит повторить. */
  onApplied: () => void;
  close: () => void;
}

export function useAdviceDialog() {
  const { openCustom } = useDialogs();
  return (props: Omit<Props, "close">) => openCustom((close) => <AdviceDialog {...props} close={close} />);
}

const verdict = (present: boolean) => (present ? "найден" : "не найден");
const exampleKind = (e: AdviceExample) => (e.isViolation ? "пример нарушения" : "корректный пример");

function AdviceDialog({ result, departmentId, attribute: preset, onApplied, close }: Props) {
  const toast = useToast();
  const { targets, mutate } = useCatalog();
  const active = targets.filter((t) => t.status === "active");
  const [attribute, setAttribute] = useState(preset ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [advice, setAdvice] = useState<Advice | null>(null);
  /** Что уже применено: "description" и nodeId правил, получивших пример. */
  const [applied, setApplied] = useState<string[]>([]);

  const found = result.detected_attributes.includes(attribute);

  async function ask() {
    if (!attribute) { toast("Выберите атрибут", "err"); return; }
    if (!reason.trim()) { toast("Напишите, почему ответ должен быть другим", "err"); return; }
    setBusy(true);
    setAdvice(null);
    setApplied([]);
    try {
      setAdvice(await api.advice({ goal: result.goal, attribute, expected: !found, reason: reason.trim(),
        department_id: departmentId }));
    } catch (err) {
      toast(errorText(err), "err");
    } finally {
      setBusy(false);
    }
  }

  async function apply(key: string, change: () => Promise<unknown>, success: string) {
    try {
      await mutate(change, success);
      setApplied((list) => [...list, key]);
      onApplied();
    } catch (err) {
      toast(errorText(err), "err");
    }
  }

  const description = advice?.description;
  const regression = advice?.regression;
  return (
    <Overlay onClose={close}>
      <div className="modal wide advice" role="dialog" aria-label="Правка графа под ожидаемый ответ">
        <h3>Как изменить граф, чтобы ответ стал другим</h3>
        <div className="content">
          <div className="field">
            <label>Цель</label>
            <div className="fix">«{result.goal}»</div>
          </div>
          <div className="field">
            <label>Атрибут, с ответом по которому вы не согласны</label>
            <Select id="adviceAttribute" ariaLabel="Атрибут" value={attribute} placeholder="Выберите атрибут"
              onChange={(next) => { setAttribute(next); setAdvice(null); }}
              options={active.map((t) => ({ value: t.name,
                label: `${t.name} — сейчас ${verdict(result.detected_attributes.includes(t.name))}` }))} />
            {attribute && (
              <div className="hint" id="adviceExpected">
                Сейчас атрибут {verdict(found)}{result.attribute_quotes?.[attribute]
                  ? ` по фрагменту «${result.attribute_quotes[attribute]}»` : ""}. Должно быть: <b>{verdict(!found)}</b>.
              </div>
            )}
          </div>
          <div className="field">
            <label htmlFor="adviceReason">Обоснование</label>
            <textarea id="adviceReason" value={reason} onChange={(e) => setReason(e.target.value)}
              placeholder="Почему ответ должен быть другим: что в цели считается или не считается этим атрибутом" />
            <div className="hint">Обоснование уходит модели: по нему она переписывает описание атрибута.</div>
          </div>

          {busy && <div className="dim"><Spinner /> Модель подбирает описание и проверяет его на цели и примерах…</div>}

          {advice && (
            <div id="adviceResult">
              {advice.notes.map((n, i) => <div key={i} className="alert" style={{ marginBottom: 8 }}>{n}</div>)}
              {advice.diagnosis && <div className="fix"><b>Почему ответ такой:</b> {advice.diagnosis}</div>}

              {description && (
                <div className="advice-block" id="adviceDescription">
                  <div className="row wrap">
                    <span className="mid">Описание атрибута «{advice.attribute}»</span>
                    {description.verified
                      ? <span className="badge ok">проверено: на этой цели атрибут {verdict(advice.expected)}</span>
                      : <span className="badge warn">ответ на этой цели не изменился</span>}
                    {description.attempts > 1 && <span className="dim">попыток: {description.attempts}</span>}
                  </div>
                  <div className="sumline"><span>Было</span><span>{description.old || "—"}</span></div>
                  <div className="sumline"><span>Предлагается</span><span>{description.new}</span></div>
                  {regression && (
                    <div className="sumline" id="adviceRegression">
                      <span>Примеры каталога</span>
                      <span>
                        {regression.checked === 0 ? "примеров про этот атрибут нет — проверить не на чем"
                          : regression.broken.length
                            ? <span className="badge err">перестали распознаваться: {regression.broken.length} из {regression.checked}</span>
                            : <span className="badge ok">проверено {regression.checked}, ни один не сломан</span>}
                        {regression.alreadyWrong > 0 && <span className="dim"> · ошибались и раньше: {regression.alreadyWrong}</span>}
                        {regression.failed > 0 && <span className="dim"> · не проверено: {regression.failed}</span>}
                        {regression.broken.map((b) => (
                          <div key={b.text} className="dim">«{b.text}» — атрибут должен быть {verdict(b.expected)}</div>
                        ))}
                      </span>
                    </div>
                  )}
                  <div className="row" style={{ marginTop: 10 }}>
                    {applied.includes("description")
                      ? <span className="badge ok">Описание сохранено</span>
                      : advice.nodeId && (
                        <button className="btn sm primary" onClick={() => void apply("description",
                          () => api.patch(advice.nodeId!, { description: description.new }), "Описание атрибута обновлено")}>
                          Применить описание
                        </button>
                      )}
                  </div>
                </div>
              )}

              {advice.examples.length > 0 && (
                <div className="advice-block" id="adviceExamples">
                  <div className="mid">Добавить цель примером правила</div>
                  {advice.examplesInPrompt && (
                    <div className="dim">Пример показывается модели рядом с описанием атрибута.</div>
                  )}
                  {advice.examples.map((e) => (
                    <div key={e.ruleNodeId} className="todo">
                      <div>{e.ruleText || e.ruleId || "правило"} <span className="dim">— {exampleKind(e)}</span></div>
                      {applied.includes(e.ruleNodeId)
                        ? <span className="badge ok">Добавлено</span>
                        : (
                          <button className="btn sm" onClick={() => void apply(e.ruleNodeId,
                            () => api.createExample({ ruleNodeId: e.ruleNodeId, text: result.goal, isViolation: e.isViolation }),
                            "Пример добавлен")}>
                            Добавить
                          </button>
                        )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="foot">
          <button className="btn" onClick={close}>Закрыть</button>
          <button className="btn primary" disabled={busy} onClick={() => void ask()}>
            {busy ? <><Spinner /> Подбираем…</> : advice ? "Предложить ещё раз" : "Предложить правку"}
          </button>
        </div>
      </div>
    </Overlay>
  );
}
