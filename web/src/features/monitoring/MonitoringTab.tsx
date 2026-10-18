import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api, type Period } from "../../api/client";
import type {
  CheckAggregate, CheckMode, CheckRecord, CheckStatus, MonitoringNow, MonitoringStats, StatsStep,
} from "../../api/types";
import { Spinner } from "../../ui/common";
import { DateTime, localDateTime } from "../../ui/DateTime";
import { Select } from "../../ui/Select";
import { errorText, useToast } from "../../ui/Toasts";

/* Что происходит с проверками: очередь и нагрузка сейчас, средние показатели
   за выбранный период и история отдельных проверок. Только администратору:
   в истории лежат формулировки целей и логины. */

const REFRESH_MS = 5000;
/** Строк на странице таблицы; больше 100 API не отдаёт. */
const PAGE_SIZES = [10, 25, 50, 100];
const TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

const STEPS: { value: StatsStep; label: string }[] = [
  { value: "minute", label: "По минутам" }, { value: "hour", label: "По часам" },
  { value: "day", label: "По дням" }, { value: "week", label: "По неделям" },
  { value: "month", label: "По месяцам" },
];
const MODES: { value: CheckMode | ""; label: string }[] = [
  { value: "", label: "Все проверки" }, { value: "single", label: "Только ручные" },
  { value: "bulk", label: "Только пакетные" },
];
const STATUS: Record<CheckStatus, { text: string; cls: string }> = {
  ALLOWED: { text: "нарушений нет", cls: "ok" },
  VIOLATIONS_FOUND: { text: "нарушения", cls: "err" },
  NEEDS_MANUAL_REVIEW: { text: "ручная проверка", cls: "warn" },
};

const num = (v: number | null | undefined) => (v == null ? "—" : v.toLocaleString("ru-RU"));
/** Миллисекунды человеку: 850 мс, 2,4 с, 3 мин 05 с. */
const dur = (ms: number | null | undefined) => {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)} мс`;
  if (ms < 60_000) return `${(ms / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} с`;
  return `${Math.floor(ms / 60_000)} мин ${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")} с`;
};
const share = (part: number, total: number) => (total ? `${Math.round((part / total) * 100)}%` : "—");
const when = (iso: string) => new Date(iso.replace(/\[.*\]$/, "")).toLocaleString("ru-RU");

/** Подпись интервала: Neo4j отдаёт начало интервала с зоной в квадратных скобках. */
function bucketLabel(bucket: string, step: StatsStep) {
  const d = new Date(bucket.replace(/\[.*\]$/, ""));
  if (step === "month") return d.toLocaleDateString("ru-RU", { month: "short", year: "numeric" });
  const date = d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
  return step === "minute" || step === "hour"
    ? `${date} ${d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}` : date;
}

export function MonitoringTab() {
  const toast = useToast();
  const [now, setNow] = useState<MonitoringNow | null>(null);
  const [nowError, setNowError] = useState<string | null>(null);

  // По умолчанию — последние семь суток целиком: с начала первого дня до конца сегодняшнего.
  const [from, setFrom] = useState(() => `${localDateTime(new Date(Date.now() - 6 * 86_400_000)).slice(0, 10)}T00:00`);
  const [to, setTo] = useState(() => `${localDateTime(new Date()).slice(0, 10)}T23:59`);
  const [step, setStep] = useState<StatsStep>("day");
  const [mode, setMode] = useState<CheckMode | "">("");
  const [busy, setBusy] = useState(false);
  const [stats, setStats] = useState<MonitoringStats | null>(null);
  // Период, по которому сейчас показаны данные: страницы истории листаются внутри него.
  const [applied, setApplied] = useState<Period | null>(null);
  const [bucketPage, setBucketPage] = useState({ page: 0, size: PAGE_SIZES[0] });
  const [historyPage, setHistoryPage] = useState({ page: 0, size: PAGE_SIZES[0] });
  const [history, setHistory] = useState<{ records: CheckRecord[]; total: number } | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);

  // Сейчас: обновляется само, пока раздел открыт.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const next = await api.monitoringNow();
        if (alive) { setNow(next); setNowError(null); }
      } catch (err) {
        if (alive) setNowError(errorText(err));
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), REFRESH_MS);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  const load = useCallback(async () => {
    if (!from || !to || from > to) { toast("Укажите период: начало не позже конца", "err"); return; }
    // Границы — местное время с точностью до минуты; последняя минута включается целиком.
    const end = new Date(to);
    end.setMinutes(end.getMinutes() + 1);
    const period: Period = { start: new Date(from).toISOString(), end: end.toISOString(), mode };
    setBusy(true);
    try {
      setStats(await api.monitoringStats(period, step, TIMEZONE));
      setBucketPage((p) => ({ ...p, page: 0 }));
      setHistoryPage((p) => ({ ...p, page: 0 }));
      setApplied(period);
    } catch (err) {
      toast(errorText(err), "err");
    } finally {
      setBusy(false);
    }
  }, [from, to, step, mode, toast]);

  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => { void loadRef.current(); }, []);

  // Страница истории читается с сервера: записей за период могут быть сотни тысяч.
  useEffect(() => {
    if (!applied) return;
    let alive = true;
    setHistoryBusy(true);
    api.monitoringHistory(applied, historyPage.size, historyPage.page * historyPage.size)
      .then((next) => { if (alive) setHistory(next); })
      .catch((err) => { if (alive) toast(errorText(err), "err"); })
      .finally(() => { if (alive) setHistoryBusy(false); });
    return () => { alive = false; };
  }, [applied, historyPage, toast]);

  const records = history?.records ?? [];
  const totals = stats?.totals?.total ? stats.totals : null;
  const points = useMemo(() => (stats?.buckets ?? []).map((b) => ({
    label: bucketLabel(b.bucket, stats!.step), total: b.total, seconds: (b.avg_computed_ms ?? 0) / 1000, row: b,
  })), [stats]);

  return (
    <section id="tab-monitoring">
      <div className="page-head">
        <div>
          <h1>Мониторинг</h1>
          <div className="sub">Очередь и нагрузка сейчас, показатели за период и история проверок.</div>
        </div>
      </div>

      <h2 className="block-title">Сейчас <span className="dim">обновляется каждые {REFRESH_MS / 1000} с</span></h2>
      {nowError && <div className="card pad"><span className="badge warn">{nowError}</span></div>}
      {!now && !nowError && <div className="card pad"><Spinner /> Загрузка…</div>}
      {now && <NowCards now={now} />}

      <h2 className="block-title">Показатели за период</h2>
      <div className="toolbar">
        <label className="row">с <DateTime id="monitoringFrom" ariaLabel="Начало периода" value={from} max={to}
          onChange={setFrom} style={{ width: 190 }} /></label>
        <label className="row">по <DateTime id="monitoringTo" ariaLabel="Конец периода" value={to} min={from}
          onChange={setTo} style={{ width: 190 }} /></label>
        <Select id="monitoringStep" ariaLabel="Периодичность" value={step} style={{ width: 170 }}
          onChange={(v) => setStep(v as StatsStep)} options={STEPS} />
        <Select id="monitoringMode" ariaLabel="Вид проверок" value={mode} style={{ width: 190 }}
          onChange={(v) => setMode(v as CheckMode | "")} options={MODES} />
        <button className="btn primary" disabled={busy} onClick={() => void load()}>
          {busy ? <><Spinner /> Считаем…</> : "Показать"}
        </button>
      </div>

      {stats && !totals && <div className="empty">За этот период проверок не было.</div>}
      {totals && (
        <>
          <div className="tiles">
            <Tile label="Проверок" value={num(totals.total)}
              note={`из кэша: ${num(totals.cached)} (${share(totals.cached, totals.total)})`} />
            <Tile label="Среднее время проверки" value={dur(totals.avg_computed_ms)}
              note={`без ответов из кэша · 95% быстрее ${dur(totals.p95_ms)}`} />
            <Tile label="Ожидание в очереди" value={dur(totals.avg_queue_ms)}
              note={`в среднем на проверку · модель: ${dur(totals.avg_llm_ms)}`} />
            <Tile label="Самая долгая" value={dur(totals.max_ms)}
              note={`запросов к модели: ${num(totals.llm_calls)}`} />
            <Tile label="С нарушениями" value={share(totals.violations, totals.total)}
              note={`${num(totals.violations)} из ${num(totals.total)}`} />
            <Tile label="На ручную проверку" value={share(totals.manual_review, totals.total)}
              note={`${num(totals.manual_review)} — сбой модели или нечем проверить`} />
          </div>
          <div className="charts">
            <BarChart title="Проверок за интервал" points={points.map((p) => ({ label: p.label, value: p.total }))}
              format={(v) => num(Math.round(v))} />
            <BarChart title="Среднее время проверки, с" points={points.map((p) => ({ label: p.label, value: p.seconds }))}
              format={(v) => v.toLocaleString("ru-RU", { maximumFractionDigits: 1 })} />
          </div>
          <div className="card scroll-x"><table>
            <thead>
              <tr>
                <th>Интервал</th><th className="r">Проверок</th><th className="r">Из кэша</th>
                <th className="r">Среднее время</th><th className="r">95%</th><th className="r">Очередь</th>
                <th className="r">Нарушения</th><th className="r">Ручная проверка</th>
              </tr>
            </thead>
            <tbody>
              {points.slice(bucketPage.page * bucketPage.size, (bucketPage.page + 1) * bucketPage.size)
                .map(({ label, row }: { label: string; row: CheckAggregate & { bucket: string } }) => (
                <tr key={row.bucket}>
                  <td>{label}</td><td className="r">{num(row.total)}</td><td className="r">{num(row.cached)}</td>
                  <td className="r">{dur(row.avg_computed_ms)}</td><td className="r">{dur(row.p95_ms)}</td>
                  <td className="r">{dur(row.avg_queue_ms)}</td>
                  <td className="r">{num(row.violations)}</td><td className="r">{num(row.manual_review)}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
          <Pager id="bucketsPager" total={points.length} {...bucketPage} onChange={setBucketPage} />
        </>
      )}

      <h2 className="block-title">История проверок <span className="dim">за выбранный период, новые сверху</span></h2>
      {records.length ? (
        <div className="card scroll-x"><table id="monitoringHistory">
          <thead>
            <tr>
              <th style={{ width: 150 }}>Когда</th><th>Цель</th><th>Подразделение</th><th>Кто</th>
              <th>Результат</th><th className="r">Время</th><th className="r">Очередь</th>
            </tr>
          </thead>
          <tbody>
            {records.map((r, i) => (
              <tr key={i}>
                <td className="dim">{when(r.at)}</td>
                <td>{r.goal}{r.violations.length > 0 && <div className="small dim">правила: {r.violations.join(", ")}</div>}</td>
                <td>{r.department_id ?? <span className="dim">—</span>}</td>
                <td>{r.login ?? <span className="dim">—</span>}
                  <div className="small dim">{r.mode === "bulk" ? `пакет ${r.batch_id ?? ""}` : "вручную"}</div></td>
                <td><span className={`badge ${STATUS[r.status]?.cls ?? ""}`}>{STATUS[r.status]?.text ?? r.status}</span></td>
                <td className="r">{dur(r.ms)}{r.cached && <div className="small dim">из кэша</div>}</td>
                <td className="r">{r.cached ? "—" : dur(r.queue_ms)}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      ) : <div className="empty">{busy || historyBusy ? "Загрузка…" : "За этот период проверок не было."}</div>}
      {history && history.total > 0 && (
        <Pager id="historyPager" total={history.total} {...historyPage} busy={historyBusy} onChange={setHistoryPage} />
      )}
    </section>
  );
}

/* Листание таблицы: размер страницы выбирается из списка, предел — 100 строк. */
function Pager({ id, total, page, size, busy, onChange }: {
  id: string; total: number; page: number; size: number; busy?: boolean;
  onChange: (next: { page: number; size: number }) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / size));
  const first = total ? page * size + 1 : 0;
  const go = (next: number) => onChange({ page: Math.min(pages - 1, Math.max(0, next)), size });
  return (
    <div className="pager" id={id}>
      <span className="muted">Строк на странице</span>
      <Select id={id + "Size"} ariaLabel="Строк на странице" value={String(size)} style={{ width: 96 }}
        onChange={(v) => onChange({ page: 0, size: Number(v) })}
        options={PAGE_SIZES.map((n) => ({ value: String(n), label: String(n) }))} />
      <span className="muted">{num(first)}–{num(Math.min(total, (page + 1) * size))} из {num(total)}</span>
      <div className="spacer" />
      {busy && <Spinner />}
      <button className="btn sm" disabled={page === 0} onClick={() => go(0)} aria-label="Первая страница">«</button>
      <button className="btn sm" disabled={page === 0} onClick={() => go(page - 1)}>Назад</button>
      <span>Страница {num(page + 1)} из {num(pages)}</span>
      <button className="btn sm" disabled={page >= pages - 1} onClick={() => go(page + 1)}>Вперёд</button>
      <button className="btn sm" disabled={page >= pages - 1} onClick={() => go(pages - 1)} aria-label="Последняя страница">»</button>
    </div>
  );
}

function Tile({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: "warn" }) {
  return (
    <div className={`card tile ${tone ?? ""}`}>
      <div className="small muted">{label}</div>
      <b>{value}</b>
      {note && <div className="small dim">{note}</div>}
    </div>
  );
}

function NowCards({ now }: { now: MonitoringNow }) {
  const { llm, checks, recent, cache, vllm, history } = now;
  const lookups = cache.hits + cache.misses;
  return (
    <>
      <div className="tiles">
        <Tile label="Очередь к модели" value={num(llm.waiting)} tone={llm.waiting > llm.capacity ? "warn" : undefined}
          note="запросов ждут свободного слота" />
        <Tile label="Запросов у модели" value={`${llm.running} из ${llm.capacity}`}
          note={`${llm.reserve} слотов оставлено ручным проверкам`} />
        <Tile label="Целей в работе" value={num(checks.running)}
          note={`ждут в принятых пакетах: ${num(checks.queued)}`} />
        <Tile label="Проверок в минуту" value={num(recent.per_minute)}
          note={`за последние ${recent.window_seconds / 60} мин: ${num(recent.checks)}`} />
        <Tile label="Среднее время проверки" value={dur(recent.avg_ms)}
          note={`за последние ${recent.window_seconds / 60} мин, без кэша`} />
        <Tile label="Ушло на ручную проверку" value={num(recent.manual_review)}
          tone={recent.manual_review ? "warn" : undefined} note={`за последние ${recent.window_seconds / 60} мин`} />
        <Tile label="vLLM" value={vllm ? `${num(vllm.running ?? 0)} в работе` : "нет ответа"} tone={vllm ? undefined : "warn"}
          note={vllm ? `в его очереди: ${num(vllm.waiting ?? 0)}`
            + (vllm.kv_cache_usage != null ? ` · KV-кэш ${Math.round(vllm.kv_cache_usage * 100)}%` : "")
            : "показатели модели недоступны"} />
        <Tile label="Кэш ответов" value={num(cache.entries)}
          note={lookups ? `попаданий: ${share(cache.hits, lookups)}` : "обращений пока не было"} />
      </div>
      {(!now.neo4j || history.dropped > 0 || !history.enabled) && (
        <div className="alert" style={{ marginTop: 12 }}>
          {!now.neo4j && "Neo4j недоступен. "}
          {!history.enabled && "Запись в историю выключена в «Настройках»: новые проверки в неё не попадают. "}
          {history.dropped > 0 && `В историю не записано проверок: ${num(history.dropped)}.`}
        </div>
      )}
      {checks.batches.length > 0 && (
        <div className="card" style={{ marginTop: 12 }}><table>
          <thead><tr><th>Пакет</th><th>Кто</th><th>Начат</th><th style={{ width: "40%" }}>Готово</th></tr></thead>
          <tbody>
            {checks.batches.map((b) => (
              <tr key={b.id}>
                <td className="mono">{b.id}</td><td>{b.login ?? "—"}</td><td className="dim">{when(b.started_at)}</td>
                <td>
                  <div className="meter" role="img" aria-label={`Готово ${b.done} из ${b.total}`}>
                    <span style={{ width: `${b.total ? (b.done / b.total) * 100 : 0}%` }} />
                  </div>
                  <span className="small dim">{num(b.done)} из {num(b.total)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </>
  );
}

/* Столбцы одной серии: без легенды (её называет заголовок), значения — в
   подсказке при наведении и в таблице ниже. */
function BarChart({ title, points, format }: {
  title: string; points: { label: string; value: number }[]; format: (v: number) => string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const W = 560, H = 190, left = 44, right = 8, top = 10, bottom = 24;
  const max = Math.max(...points.map((p) => p.value), 0) || 1;
  const slot = (W - left - right) / Math.max(points.length, 1);
  const bar = Math.max(1, Math.min(24, slot - 2));
  const y = (v: number) => top + (H - top - bottom) * (1 - v / max);
  // Подписи оси — не чаще, чем помещаются.
  const every = Math.ceil(points.length / 6);
  const tip = active != null ? points[active] : null;
  return (
    <div className="card pad chart">
      <h3>{title}</h3>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title} onMouseLeave={() => setActive(null)}>
        {[0, 0.5, 1].map((t) => (
          <g key={t}>
            <line x1={left} x2={W - right} y1={y(max * t)} y2={y(max * t)} className="grid" />
            <text x={left - 6} y={y(max * t) + 4} textAnchor="end">{format(max * t)}</text>
          </g>
        ))}
        {points.map((p, i) => {
          const x = left + slot * i + (slot - bar) / 2;
          const h = Math.max(p.value > 0 ? 2 : 0, H - bottom - y(p.value));
          const r = Math.min(4, bar / 2, h);
          return (
            <g key={i}>
              <path className={`bar ${active === i ? "active" : ""}`}
                d={`M${x},${H - bottom} v${-(h - r)} q0,${-r} ${r},${-r} h${bar - 2 * r} q${r},0 ${r},${r} v${h - r} z`} />
              {i % every === 0 && <text x={x + bar / 2} y={H - 7} textAnchor="middle">{p.label}</text>}
              <rect x={left + slot * i} y={top} width={slot} height={H - top - bottom} fill="transparent"
                onMouseEnter={() => setActive(i)} />
            </g>
          );
        })}
      </svg>
      <div className="chart-tip">{tip ? <><b>{format(tip.value)}</b> · {tip.label}</> : "Наведите на столбец"}</div>
    </div>
  );
}
