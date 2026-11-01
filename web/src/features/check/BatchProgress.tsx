import { useState } from "react";
import type { BatchItemProgress, CheckStage } from "../../api/client";
import type { BatchLive, BatchRow } from "../../state/checkForm";
import { count, seconds, SHORT, Tokens } from "./CheckProgress";

/* Ход пакетной проверки: сколько проверено и сколько осталось, скорость, токены,
   среднее время шагов на цель и цели, которые прямо сейчас у модели. Только для
   интерфейса — внешние системы получают обычный ответ /check-goals. После
   пакета блок сворачивается в строку с итогом (её можно развернуть). */

/** Шаги проверки цели по порядку — точки у целей «Сейчас у модели». */
const ORDER: CheckStage["key"][] = ["cache", "queue", "attributes", "jobs", "smart", "rules"];
/** Обращения к модели идут одновременно: пока идёт одно, горят все три. */
const PARALLEL: CheckStage["key"][] = ["attributes", "jobs", "smart"];

function Dots({ stage }: { stage: CheckStage["key"] | null }) {
  const at = stage ? ORDER.indexOf(stage) : -1;
  const parallel = stage !== null && PARALLEL.includes(stage);
  return (
    <span className="bp-dots" title={stage ? SHORT[stage] : undefined}>
      {ORDER.map((key, i) => {
        const running = key === stage || (parallel && PARALLEL.includes(key));
        const done = !running && i < at;
        return <span key={key} className={`bp-dot ${running ? "running" : done ? "done" : ""}`} />;
      })}
    </span>
  );
}

export function BatchProgress({ live, rows, running }: { live: BatchLive | null; rows: BatchRow[]; running: boolean }) {
  const [open, setOpen] = useState(false);
  if (!live) return null;
  const items = Object.values(live.items);
  const done = items.filter((i) => i.status === "done");
  const inWork = items.filter((i) => i.status === "running");
  const bad = done.filter((i) => i.verdict === "VIOLATIONS_FOUND").length;
  const manual = done.filter((i) => i.verdict === "NEEDS_MANUAL_REVIEW").length;
  const cached = done.filter((i) => i.cached).length;
  const queued = Math.max(0, live.total - done.length - inWork.length);
  const elapsed = live.elapsedSeconds;
  const perMinute = done.length && elapsed > 1 ? Math.round(done.length / elapsed * 60) : null;
  const left = done.length && !live.finished ? Math.round((live.total - done.length) / (done.length / elapsed)) : null;
  const share = (n: number) => `${(n / Math.max(live.total, 1)) * 100}%`;
  const averages = ORDER.filter((k) => k !== "cache" && k !== "queue" && live.stageSeconds[k]?.count)
    .map((k) => `${SHORT[k]} ${seconds(live.stageSeconds[k]!.total / live.stageSeconds[k]!.count)}`);
  const goals = new Map(rows.map((r, i) => [r.key, { n: i + 1, goal: r.goal }]));
  const lanes = Object.entries(live.items).filter(([, i]) => i.status === "running")
    .sort(([a], [b]) => (goals.get(a)?.n ?? 0) - (goals.get(b)?.n ?? 0));

  if (live.finished && !open) {
    return (
      <div className="card pad cp cp-summary" id="batchProgress">
        <span className="ico sm good" aria-hidden="true">✓</span>
        <span>Проверено {done.length} из {live.total} за <b>{seconds(elapsed)}</b></span>
        <span className="cp-detail">
          {[perMinute != null && `${perMinute} целей/мин`, cached && `из кэша ${cached}`, ...averages]
            .filter(Boolean).join(" · ")}
        </span>
        <Tokens progress={live} />
        <button type="button" className="btn sm ghost" onClick={() => setOpen(true)}>Подробнее</button>
      </div>
    );
  }

  return (
    <div className="card pad cp" id="batchProgress" aria-live="polite">
      <div className="cp-head">
        {live.finished ? <span className="ico sm good" aria-hidden="true">✓</span>
          : <span className="cp-icon spinning" aria-hidden="true" />}
        <span className="mid">Ход пакетной проверки</span>
        <Tokens progress={live} />
        <span className="cp-time">{seconds(elapsed)}</span>
        {live.finished && <button type="button" className="btn sm ghost" onClick={() => setOpen(false)}>Свернуть</button>}
      </div>
      <div className="bp-bar" role="progressbar" aria-valuemin={0} aria-valuemax={live.total} aria-valuenow={done.length}>
        <i className="ok" style={{ width: share(done.length - bad - manual) }} />
        <i className="warn" style={{ width: share(manual) }} />
        <i className="bad" style={{ width: share(bad) }} />
        <i className="run" style={{ width: share(inWork.length) }} />
      </div>
      <div className="bp-line">
        <span>Проверено {done.length} из {live.total}</span>
        <span>{live.finished ? (running ? "" : "готово") : left != null ? `осталось ≈ ${left} с` : "осталось ≈ —"}</span>
      </div>
      <div className="bp-stats">
        <div><span>Целей в минуту</span><b>{perMinute ?? "—"}</b></div>
        <div><span>В работе / в очереди</span><b>{inWork.length} / {queued}</b></div>
        <div><span>Из кэша</span><b>{count(cached)}</b></div>
        <div><span>С нарушениями</span><b>{count(bad)}</b></div>
      </div>
      {averages.length > 0 && <div className="cp-detail bp-avg">Среднее на цель: {averages.join(" · ")}</div>}
      {!live.finished && (
        <div className="bp-lanes">
          <div className="cp-note" style={{ margin: "10px 0 4px" }}>Сейчас у модели</div>
          {lanes.length ? lanes.map(([key, item]) => (
            <div key={key} className="bp-lane">
              <span className="cp-icon spinning" aria-hidden="true" />
              <span className="bp-goal">{goals.get(key)?.n}. {goals.get(key)?.goal}</span>
              <Dots stage={item.stage} />
              <span className="cp-time">{item.seconds != null ? seconds(item.seconds) : ""}</span>
            </div>
          )) : <div className="cp-detail">Ждём свободное место у модели</div>}
        </div>
      )}
    </div>
  );
}

/** Статус строки, пока её цель в пакете: в очереди или проверяется — с временем. */
export function RowLive({ item }: { item: BatchItemProgress }) {
  if (item.status === "queued") return <span className="badge bp-queued">в очереди</span>;
  if (item.status === "running")
    return <span className="bp-row-run"><span className="cp-icon spinning" aria-hidden="true" />проверяется… {item.seconds != null ? seconds(item.seconds) : ""}</span>;
  return null;
}
