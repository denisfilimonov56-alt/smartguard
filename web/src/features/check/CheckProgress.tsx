import { useState } from "react";
import type { CheckProgress as Progress, CheckStage } from "../../api/client";

/* Ход проверки одной цели: что делает сервис прямо сейчас, сколько занял каждый
   шаг и сколько токенов выдала модель. Только для интерфейса — внешние системы
   получают обычный ответ /check-goal. Пока проверка идёт, шаги видны целиком;
   после ответа сворачиваются в строку с временем шагов (её можно развернуть). */

export const LABELS: Record<CheckStage["key"], string> = {
  cache: "Готовый ответ в кэше",
  queue: "Очередь к модели",
  attributes: "Атрибуты в тексте цели",
  jobs: "Сравнение с инструкциями подразделения",
  smart: "Оценка SMART",
  rules: "Правила в графе",
};
/** Короткие подписи для свёрнутой строки. */
export const SHORT: Record<CheckStage["key"], string> = {
  cache: "кэш", queue: "очередь", attributes: "атрибуты", jobs: "инструкции", smart: "SMART", rules: "граф",
};
/** Обращения к модели идут одновременно — они показаны одной группой. */
const PARALLEL: CheckStage["key"][] = ["attributes", "jobs", "smart"];

export const seconds = (value: number) => value.toFixed(1).replace(".", ",") + " с";
export const count = (value: number) => value.toLocaleString("ru-RU");

/** Значок шага: готовый — та же галочка, что у выполненного правила в «Что проверяется»;
    идущий — крутящееся кольцо, пропущенный — пунктирное, ждущий — пустое. */
function StageIcon({ status }: { status: CheckStage["status"] }) {
  if (status === "done") return <span className="ico sm good" aria-hidden="true">✓</span>;
  return <span className="cp-icon" aria-hidden="true" />;
}

function Stage({ stage, progress }: { stage: CheckStage; progress: Progress }) {
  return (
    <div className={`cp-step ${stage.status}`}>
      <StageIcon status={stage.status} />
      <div className="cp-body">
        <div>{LABELS[stage.key]}</div>
        <div className="cp-detail">
          {stage.detail}
          {stage.tokens != null && <span className="cp-tokens"> · {count(stage.tokens)} ток.</span>}
        </div>
        {stage.key === "attributes" && progress.attributes.length > 0 && (
          <div className="cp-chips">
            {progress.attributes.map((a) => (
              <span key={a.name} className="cp-chip" title={a.quote ? `«${a.quote}»` : undefined}>{a.name}</span>
            ))}
          </div>
        )}
        {stage.key === "jobs" && progress.matchedDuties.length > 0 && (
          <div className="cp-chips">
            {progress.matchedDuties.map((d) => <span key={d} className="cp-chip warn">«{d}»</span>)}
          </div>
        )}
      </div>
      <span className="cp-time">{stage.seconds != null ? seconds(stage.seconds) : ""}</span>
    </div>
  );
}

/** Токены и скорость генерации: «1 520 → 210 ток. · 48 ток/с». Общие с ходом пакета. */
export function Tokens({ progress }: { progress: Pick<Progress, "tokens" | "tokensPerSecond"> }) {
  const { prompt, completion } = progress.tokens;
  if (!prompt && !completion) return null;
  return (
    <span className="cp-tokens" title="Токены запроса → токены ответа модели; скорость — токенов ответа в секунду">
      {count(prompt)} → {count(completion)} ток.
      {progress.tokensPerSecond != null && <> · {count(progress.tokensPerSecond)} ток/с</>}
    </span>
  );
}

export function CheckProgress({ progress, busy }: { progress: Progress | null; busy: boolean }) {
  const [open, setOpen] = useState(false);
  if (!progress) return null;
  const finished = !busy;
  const byKey = (key: CheckStage["key"]) => progress.stages.find((s) => s.key === key);
  const before = progress.stages.filter((s) => s.key === "cache" || s.key === "queue");
  const parallel = PARALLEL.map(byKey).filter((s): s is CheckStage => !!s);
  const after = progress.stages.filter((s) => s.key === "rules");

  if (finished && !open) {
    const timed = progress.stages.filter((s) => s.status === "done" && s.seconds != null && s.seconds >= 0.1);
    return (
      <div className="card pad cp cp-summary" id="checkProgress">
        <span>Проверено за <b>{seconds(progress.elapsedSeconds)}</b></span>
        <span className="cp-detail">{timed.map((s) => `${SHORT[s.key]} ${seconds(s.seconds!)}`).join(" · ")}</span>
        <Tokens progress={progress} />
        <button type="button" className="btn sm ghost" onClick={() => setOpen(true)}>Подробнее</button>
      </div>
    );
  }

  return (
    <div className="card pad cp" id="checkProgress" aria-live="polite">
      <div className="cp-head">
        <span className="mid">Ход проверки</span>
        <Tokens progress={progress} />
        <span className="cp-time">{seconds(progress.elapsedSeconds)}</span>
        {finished && <button type="button" className="btn sm ghost" onClick={() => setOpen(false)}>Свернуть</button>}
      </div>
      {before.map((s) => <Stage key={s.key} stage={s} progress={progress} />)}
      <div className="cp-note">Одновременно:</div>
      <div className="cp-lanes">
        {parallel.map((s) => <Stage key={s.key} stage={s} progress={progress} />)}
      </div>
      {after.map((s) => <Stage key={s.key} stage={s} progress={progress} />)}
    </div>
  );
}
