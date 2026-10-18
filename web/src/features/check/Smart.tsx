import { useEffect, useState } from "react";

import type { SmartKey, SmartScores } from "../../api/types";

/* Оценка цели по SMART: пять кругов — по одному на букву. Это справка
   автору цели, на вердикт по приказам она не влияет (api/agent.py: assess_smart).
   При появлении ответа круги заполняются, а числа растут от нуля к оценке —
   по очереди, слева направо; сами круги при этом на месте, без появления. */

export const SMART_LETTERS: { key: SmartKey; letter: string; name: string }[] = [
  { key: "specific", letter: "S", name: "Конкретная" },
  { key: "measurable", letter: "M", name: "Измеримая" },
  { key: "achievable", letter: "A", name: "Достижимая" },
  { key: "relevant", letter: "R", name: "Значимая" },
  { key: "time_bound", letter: "T", name: "В срок" },
];

const RADIUS = 24;
const LENGTH = 2 * Math.PI * RADIUS;
/** Длительность роста одного круга и задержка между соседними, мс. */
const DURATION = 900;
const STAGGER = 120;

const level = (score: number) => (score >= 70 ? "ok" : score >= 40 ? "warn" : "bad");
const clamp = (score: number) => Math.min(Math.max(score, 0), 100);

const reducedMotion = () =>
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Значение, растущее от 0 к target за DURATION мс после задержки delay, с замедлением к концу.
    Новый ответ (другой объект smart) запускает рост заново; при prefers-reduced-motion — сразу target. */
function useRise(target: number, delay: number, epoch: unknown): number {
  const [value, setValue] = useState(() => (reducedMotion() ? target : 0));
  useEffect(() => {
    if (reducedMotion()) { setValue(target); return; }
    setValue(0);
    const start = performance.now() + delay;
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(Math.max((now - start) / DURATION, 0), 1);
      setValue(target * (1 - Math.pow(1 - t, 3)));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, delay, epoch]);
  return value;
}

/** Круг с долей заполнения по оценке 0–100 и буквой критерия в центре. */
function Ring({ letter, score }: { letter: string; score: number }) {
  const filled = LENGTH * clamp(score) / 100;
  return (
    <svg viewBox="0 0 60 60" aria-hidden="true">
      <circle className="track" cx="30" cy="30" r={RADIUS} />
      <circle className="val" cx="30" cy="30" r={RADIUS} strokeDasharray={`${filled} ${LENGTH - filled}`}
        transform="rotate(-90 30 30)" />
      <text x="30" y="31" textAnchor="middle" dominantBaseline="central">{letter}</text>
    </svg>
  );
}

function RingItem({ index, letter, name, score, comment, compact, epoch, smartKey }: {
  index: number; letter: string; name: string; score: number; comment?: string; compact?: boolean; epoch: unknown;
  smartKey: SmartKey;
}) {
  const shown = useRise(clamp(score), index * STAGGER, epoch);
  // Цвет — по итоговой оценке: пока круг растёт, он не перекрашивается.
  return (
    <div className={`ring ${level(score)}`} role="listitem" data-smart={smartKey} data-score={score}
      title={comment || undefined} aria-label={`${letter} — ${name}: ${score} из 100`}>
      <Ring letter={letter} score={shown} />
      <div className="name">{name} <span className="score">{Math.round(shown)}</span></div>
      {!compact && comment && <div className="why">{comment}</div>}
    </div>
  );
}

export function SmartRings({ smart, compact }: { smart: SmartScores; compact?: boolean }) {
  return (
    <div className={`smart ${compact ? "compact" : ""}`} id="checkSmart" role="list" aria-label="Оценка по SMART">
      {SMART_LETTERS.map(({ key, letter, name }, index) => {
        const item = smart[key];
        return (
          <RingItem key={key} index={index} letter={letter} name={name} score={item?.score ?? 0}
            comment={item?.comment} compact={compact} epoch={smart} smartKey={key} />
        );
      })}
    </div>
  );
}
