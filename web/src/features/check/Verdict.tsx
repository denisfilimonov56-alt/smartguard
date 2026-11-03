import type { ReactNode } from "react";

import type { CheckResult, SmartScores } from "../../api/types";
import { attributeTitle, Chip } from "../../ui/common";
import { place, plural, ruleKey, unverifiedCount } from "./batch";
import { SmartRings } from "./Smart";

/* Ответ проверки одной цели человеческим языком: что не так, какой пункт
   приказа и как исправить. Используется и для одной цели, и для каждой
   цели пакета. */

export function Verdict({ result, total, onTrace, onDispute, onAttribute, menu }: {
  result: CheckResult;
  /** Сколько правил проверялось для подразделения цели. */
  total: number;
  /** Показать путь проверки на графе. */
  onTrace?: () => void;
  /** Не согласен с ответом по атрибуту нарушения — открыть советчика. */
  onDispute?: (attribute: string) => void;
  /** Открыть атрибут в словаре. */
  onAttribute?: (attribute: string) => void;
  /** Кнопка «⋯» в шапке ответа (ответ API и т. п.). */
  menu?: ReactNode;
}) {
  // Атрибут — человеческим названием; служебное имя — в подсказке.
  const attribute = (name: string) => (onAttribute
    ? <button type="button" className="chip chip-btn" title={`Открыть атрибут «${name}»`} onClick={() => onAttribute(name)}>{attributeTitle(name)}</button>
    : <Chip title={name}>{attributeTitle(name)}</Chip>);
  const manual = result.status === "NEEDS_MANUAL_REVIEW";
  // Нарушенных правил, а не пар «правило × атрибут»: правило с двумя атрибутами — одно.
  const bad = new Set(result.violations.map(ruleKey)).size;
  // Правила, которые API проверить не смог: ни «выполнено», ни «не выполнено» — отдельно, со знаком «?».
  const unverified = unverifiedCount(result);
  const rulesLine = bad
    ? `не выполнено правил: ${bad} из ${total}${unverified ? ` · не проверено: ${unverified}` : ""}`
    : unverified ? `проверено правил: ${Math.max(0, total - unverified)} из ${total} · не проверено: ${unverified}`
    : `проверено правил: ${total}`;
  // Подразделение и признак студента видны в форме проверки и в «Что проверяется» — в шапке ответа их нет.
  return (
    <div className="card verdict" id="checkResult">
      <div className="row wrap verdict-head">
        {manual
          ? <span className="badge warn lg">Требуется ручная проверка</span>
          : bad ? <span className="badge err lg">Нужно доработать</span> : <span className="badge ok lg">Нарушений нет</span>}
        {(!manual || unverified > 0) && <span className="mid" data-rules-line>{rulesLine}</span>}
        <div className="spacer" />
        {!manual && onTrace && <button className="btn sm" onClick={onTrace}>Показать на графе</button>}
        {menu}
      </div>

      {result.notes.map((n, i) => <div key={i} className="alert" style={{ marginBottom: 8 }}>{n}</div>)}

      {unverified > 0 && (
        <div className="vitem unverified">
          <span className="ico unknown" title="Не проверено: нужна ручная проверка">?</span>
          <div className="t" style={{ fontSize: 14 }}>Не проверено: {plural(unverified, ["правило", "правила", "правил"])}</div>
          <div className="d">Ни выполненными, ни нарушенными их считать нельзя — сверьте цель с ними вручную.</div>
        </div>
      )}

      {result.violations.map((v, i) => {
        const examples = v.examples.filter((e): e is string => !!e);
        const duties = (v.matched_duties ?? []).filter((m) => m.duty);
        return (
          <div key={i} className="vitem violation">
            <span className="ico bad">✕</span>
            <div className="t">
              <span className="grow">{v.rule_text}</span>
              {onDispute && (
                <button className="btn sm ghost" title="Предложить правку графа, чтобы ответ по атрибуту стал другим"
                  onClick={() => onDispute(v.attribute)}>Не согласен</button>
              )}
            </div>
            {/* Где правило и по какому атрибуту: текст пункта — в подсказке, чтобы строка не разрасталась. */}
            <div className="d" title={v.clause_text ?? undefined}>{place(v)} · атрибут {attribute(v.attribute)}</div>
            {(v.check_instruction || examples.length > 0 || duties.length > 0) && (
              <div className="fix">
                {duties.map((m, j) => (
                  <div key={"d" + j}><b>Совпадает с обязанностью{m.title ? ` (${m.title})` : ""}:</b> «{m.duty}»</div>
                ))}
                {v.check_instruction && <div><b>Как исправить:</b> {v.check_instruction}</div>}
                {examples.map((ex, j) => (
                  <div key={j}><b>{v.example_kind === "violation" ? "Так нельзя:" : "Пример:"}</b> «{ex}»</div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {!manual && result.detected_attributes.length > 0 && (
        <div className="vitem">
          <span className="ico good">✓</span>
          <div className="t" style={{ fontSize: 14 }}>Найдено в цели</div>
          {result.detected_attributes.map((a) => (
            <div key={a} className="d chips">
              {attribute(a)}
              {result.attribute_quotes?.[a] && <span className="quote">«{result.attribute_quotes[a]}»</span>}
            </div>
          ))}
        </div>
      )}

      {/* SMART — справка автору, на вердикт не влияет: в конце, всегда целиком — круги с пояснениями. */}
      {result.smart && <SmartBlock smart={result.smart} />}
    </div>
  );
}

function SmartBlock({ smart }: { smart: SmartScores }) {
  return (
    <div className="smart-block">
      <div className="smart-head">
        <b>SMART</b><span className="dim">справочно, на вердикт не влияет</span>
      </div>
      <SmartRings smart={smart} />
    </div>
  );
}
