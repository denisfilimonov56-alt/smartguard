import type { CheckResult } from "../../api/types";
import { Chip } from "../../ui/common";
import { place, ruleKey } from "./batch";
import { SmartRings } from "./Smart";

/* Ответ проверки одной цели человеческим языком: что не так, какой пункт
   приказа и как исправить. Используется и для одной цели, и для каждой
   цели пакета. */

export function Verdict({ result, total, onTrace, onDispute, onAttribute }: {
  result: CheckResult;
  /** Сколько правил проверялось для подразделения цели. */
  total: number;
  /** Показать путь проверки на графе. */
  onTrace?: () => void;
  /** Не согласен с ответом по атрибуту нарушения — открыть советчика. */
  onDispute?: (attribute: string) => void;
  /** Открыть атрибут в словаре. */
  onAttribute?: (attribute: string) => void;
}) {
  const attribute = (name: string) => (onAttribute
    ? <button type="button" className="chip chip-btn" title="Открыть атрибут" onClick={() => onAttribute(name)}>{name}</button>
    : <Chip>{name}</Chip>);
  const manual = result.status === "NEEDS_MANUAL_REVIEW";
  // Нарушенных правил, а не пар «правило × атрибут»: правило с двумя атрибутами — одно.
  const bad = new Set(result.violations.map(ruleKey)).size;
  return (
    <div className="card verdict" id="checkResult">
      <div className="row wrap" style={{ paddingBottom: 12 }}>
        {manual
          ? <span className="badge warn lg">Требуется ручная проверка</span>
          : bad ? <span className="badge err lg">Нужно доработать</span> : <span className="badge ok lg">Нарушений нет</span>}
        {!manual && <span className="muted">{bad ? `не выполнено правил: ${bad} из ${total}` : `проверено правил: ${total}`}</span>}
        <div className="spacer" />
        {!manual && onTrace && <button className="btn sm" onClick={onTrace}>Показать на графе</button>}
        <span className="dim">подразделение: {result.department
          ? <Chip>{result.department.name || result.department.id}</Chip> : "не определено"}</span>
        {result.is_student && <span className="dim"><Chip>студент</Chip></span>}
      </div>

      {result.notes.map((n, i) => <div key={i} className="alert" style={{ marginBottom: 8 }}>{n}</div>)}

      {result.smart && (
        <div className="vitem smart-block">
          <span className="ico smart-ico">S</span>
          <div className="t" style={{ fontSize: 14 }}>По SMART <span className="dim" style={{ fontWeight: 400 }}>справочно, на вердикт не влияет</span></div>
          <div className="d"><SmartRings smart={result.smart} /></div>
        </div>
      )}

      {result.violations.map((v, i) => {
        const examples = v.examples.filter((e): e is string => !!e);
        const duties = (v.matched_duties ?? []).filter((m) => m.duty);
        return (
          <div key={i} className="vitem violation">
            <span className="ico bad">✕</span>
            <div className="t">{v.rule_text}</div>
            <div className="d">{place(v)} · атрибут {attribute(v.attribute)}
              {onDispute && (
                <button className="btn sm ghost" title="Предложить правку графа, чтобы ответ по атрибуту стал другим"
                  onClick={() => onDispute(v.attribute)}>Не согласен</button>
              )}
            </div>
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
    </div>
  );
}
