import { memo, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";

import type { CheckResult, CheckStatus, Department } from "../../api/types";
import { columnName, downloadFile, openWorkbook, XlsxError, type Sheet, type WorkbookSheet } from "../../lib/xlsx";
import { useAuth } from "../../state/auth";
import { useCatalog } from "../../state/catalog";
import { useCheckForm, type BatchRow, type BatchSnapshot } from "../../state/checkForm";
import { ruleApplies } from "../../state/scope";
import { activeRuleRefs } from "../../state/tree";
import { Spinner } from "../../ui/common";
import { copyText } from "../../ui/clipboard";
import { Overlay, useDialogs } from "../../ui/Dialogs";
import { useMenu, type MenuItem } from "../../ui/Menu";
import { Select, type SelectOption } from "../../ui/Select";
import { errorText, useToast } from "../../ui/Toasts";
import type { BatchItemProgress } from "../../api/client";
import { useAdviceDialog } from "./AdviceDialog";
import { BatchProgress, RowLive } from "./BatchProgress";
import { seconds } from "./CheckProgress";
import {
  MAX_ROWS, SHEET_MAX_ROWS, detectColumns, emptyRow, hasErrors, plural, resultsWorkbook,
  ruleKey, rowsFromSheet, sameRow, sheetWidth, summaryOf, templateWorkbook, validateRows,
  failedTemporarily, type Columns, type Issue,
} from "./batch";
import { JsonDialog } from "./JsonBlock";
import { Verdict } from "./Verdict";

/* Проверка нескольких целей сразу: список целей «цель — подразделение —
   студент — идентификатор», который заполняют вручную или из файла Excel. Слева —
   все цели со статусом, справа — выбранная: её поля и разбор как у одиночной проверки.
   Перед отправкой строки проверяются здесь же: пустая цель, неизвестное подразделение
   и т. п. не дают нажать «Проверить». Ответ выгружается обратно в Excel.
   Сам пакет идёт в state/checkForm.tsx: уход со страницы его не прерывает. */

const MAX_FILE_BYTES = 10 * 1024 * 1024;

const departmentOptions = (departments: Department[]) =>
  departments.filter((d) => d.departmentId && d.status === "active")
    .map((d) => ({ value: d.departmentId!, label: d.name || d.departmentId! }));

/** Ответ по строке: статус, «изменено после проверки», «API не успел проверить» или ничего (строку не проверяли). */
type Outcome = CheckStatus | "stale" | "unchecked" | "failed" | undefined;

export function BatchCheck() {
  const toast = useToast();
  const { openCustom } = useDialogs();
  const { canEdit, goalMaxChars } = useAuth();
  const openAdvice = useAdviceDialog();
  const catalog = useCatalog();
  const { departments } = catalog;
  const { checkForm, setCheckForm, batchRun } = useCheckForm();
  const { rows, departmentId: fallback, batch } = checkForm;
  const fileInput = useRef<HTMLInputElement>(null);
  const openMenu = useMenu();
  // Выбранная цель; если её убрали — первая.
  const [selected, setSelected] = useState<string | null>(null);
  const currentIndex = Math.max(0, rows.findIndex((r) => r.key === selected));
  const current = rows[currentIndex] as BatchRow | undefined;

  const options = useMemo(() => departmentOptions(departments), [departments]);
  const names = useMemo(() => new Map(options.map((o) => [o.value, o.label])), [options]);
  const fallbackName = names.get(fallback);
  const verdictProps = useVerdictProps(catalog, canEdit, openAdvice);
  const issues = useMemo(() => validateRows(rows, departments, fallback, goalMaxChars),
    [rows, departments, fallback, goalMaxChars]);
  const broken = rows.filter((r) => hasErrors(issues.get(r.key))).length;
  const tooMany = rows.length > MAX_ROWS;
  const busy = batchRun.running;

  const setRows = useCallback((update: (prev: BatchRow[]) => BatchRow[]) =>
    setCheckForm((prev) => ({ rows: update(prev.rows) })), [setCheckForm]);
  const patch = useCallback((key: string, change: Partial<BatchRow>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...change } : r))), [setRows]);
  const remove = useCallback((key: string) => {
    // Выбор переходит на соседнюю цель: следующую, а у последней — предыдущую.
    const at = rows.findIndex((r) => r.key === key);
    setSelected((rows[at + 1] ?? rows[at - 1])?.key ?? null);
    setRows((prev) => prev.filter((r) => r.key !== key));
  }, [rows, setRows]);
  // Только что добавленная цель: в её поле сразу ставится курсор.
  const [added, setAdded] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const add = () => {
    const row = emptyRow();
    setRows((prev) => [...prev, row]);
    setSelected(row.key);
    setAdded(row.key);
  };

  // Ответ по строке — только пока строка та же, что проверялась: после правки цели,
  // подразделения, признака студента или идентификатора прежний статус к ней не относится.
  const checked = useMemo(() => new Map(batch?.rows.map((r, i) => [r.key, { row: r, result: batch.result.results[i] }])), [batch]);
  const outcomeOf = (row: BatchRow): Outcome => {
    const hit = checked.get(row.key);
    if (!hit?.result) return undefined;
    if (!sameRow(row, hit.row, fallback, batch!.fallback)) return "stale";
    return hit.result.unchecked ? "unchecked" : failedTemporarily(hit.result) ? "failed" : hit.result.status;
  };

  async function pick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) await openFile(file);
  }

  /** Строки, вставленные из Excel или таблицы (столбцы через табуляцию): заголовок узнаётся,
      как в файле; без заголовка — цель, подразделение, студент по порядку. */
  function paste(text: string) {
    const lines = text.split(/\r?\n/).map((line) => line.split("\t")).filter((cells) => cells.some((c) => c.trim()));
    if (!lines.length) return;
    const found = detectColumns(lines);
    const width = sheetWidth(lines);
    const { columns, header } = found.columns.goal !== null ? found : {
      columns: { goal: 0, department: width > 1 ? 1 : null, id: null, student: width > 2 ? 2 : null }, header: false };
    const imported = rowsFromSheet({ name: "", rows: lines }, columns, header, departments);
    if (!imported.length) return;
    setRows((prev) => [...prev.filter((r) => r.goal.trim() || r.departmentId || r.id), ...imported]);
    setSelected(imported[0].key);
    toast(`Вставлено: ${plural(imported.length, ["строка", "строки", "строк"])}`, "ok");
  }

  async function openFile(file: File) {
    if (file.size > MAX_FILE_BYTES) { toast("Файл больше 10 МБ: оставьте в нём только лист с целями", "err"); return; }
    let sheets: WorkbookSheet[];
    try {
      sheets = await openWorkbook(await file.arrayBuffer());
    } catch (err) {
      toast(err instanceof XlsxError ? err.message : "Не удалось прочитать файл: " + errorText(err), "err");
      return;
    }
    openCustom((close) => (
      <ImportDialog file={file.name} sheets={sheets} departments={departments} fallback={fallback} close={close}
        onImport={(imported) => {
          // Пустые строки-заготовки загруженные вытесняют, заполненные остаются.
          setRows((prev) => [...prev.filter((r) => r.goal.trim() || r.departmentId || r.id), ...imported]);
          if (imported[0]) setSelected(imported[0].key);
          toast(`Загружено: ${plural(imported.length, ["строка", "строки", "строк"])}`, "ok");
        }} />
    ));
  }

  // Строки без действующего ответа: пакет прервали (лимит, сбой, «Остановить»), API не успел их проверить
  // до срока пакета (unchecked), проверка сорвалась из-за временного сбоя (failed) или их изменили после проверки.
  const pending = batch ? rows.filter((r) => {
    const o = outcomeOf(r);
    return o === undefined || o === "stale" || o === "unchecked" || o === "failed";
  }).length : 0;

  /** onlyPending — проверить только строки без ответа и изменённые, остальным оставить прежний ответ. */
  function run(onlyPending = false) {
    if (busy) return;
    if (!rows.length) { toast("Добавьте хотя бы одну цель", "err"); return; }
    if (broken) { toast("Сначала исправьте строки с ошибками", "err"); return; }
    if (tooMany) { toast(`За один раз можно проверить не более ${MAX_ROWS} целей`, "err"); return; }
    void batchRun.start(rows, fallback, onlyPending);
  }

  return (
    <>
      <div className="hero">
        <h1>Проверьте несколько целей</h1>
        <div className="hint" style={{ marginTop: 6 }}>
          Таблица или файл Excel со столбцами «Цель», «Подразделение» и, если есть, «Идентификатор» и «Студент».
          Подразделение у каждой цели обязательно: без него проверка не отправляется.
        </div>
        {/* Как в форме одной цели: параметры слева, запуск справа. Файл и шаблон — в шапке списка или в зоне загрузки. */}
        <div className="row wrap" style={{ marginTop: 14 }}>
          <input ref={fileInput} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="hidden" aria-label="Файл Excel" onChange={(e) => void pick(e)} />
          <Select id="batchDepartment" ariaLabel="Подразделение для строк без него" className="pill glass" value={fallback}
            style={{ width: 340 }} onChange={(next) => setCheckForm({ departmentId: next })}
            options={[{ value: "", label: "По умолчанию: не выбрано" },
              ...options.map((o) => ({ value: o.value, label: `По умолчанию: ${o.label}` }))]} />
          <div className="spacer" />
          {!busy && pending > 0 && pending < rows.length && (
            <button className="btn" id="batchContinue" title="Строки с ответом не отправляются снова и не тратят лимит проверок"
              onClick={() => run(true)}>Проверить оставшиеся ({pending})</button>
          )}
          {!busy && !rows.length && <span className="hint" style={{ margin: 0 }}>Добавьте цели, чтобы проверить</span>}
          <button className="btn primary" id="batchRun" disabled={busy || !rows.length} onClick={() => run()}>
            {busy ? <><Spinner /> Проверено {batchRun.done} из {batchRun.total}
              {batchRun.waiting === null ? "…" : batchRun.waitReason === "rate"
                ? ` · лимит проверок в минуту, повтор через ${batchRun.waiting} с`
                : ` · очередь занята, повтор через ${batchRun.waiting} с`}</>
              : `Проверить${rows.length ? (pending > 0 && pending < rows.length ? ` все (${rows.length})` : ` (${rows.length})`) : ""}`}
          </button>
          {busy && <button className="btn" id="batchStop" onClick={batchRun.stop}>Остановить</button>}
        </div>
      </div>

      <BatchProgress live={batchRun.live} rows={rows} running={busy} />

      <div className="card batch-card" id="batchRows" style={{ marginTop: 16 }}>
        <div className="row wrap batch-head">
          <span className="mid">{rows.length ? plural(rows.length, ["цель", "цели", "целей"]) : "Целей пока нет"}</span>
          {batch && <BatchSummary batch={batch} />}
          {broken > 0 && <span className="badge err">с ошибками: {broken}</span>}
          {tooMany && <span className="badge err">не более {MAX_ROWS} целей за раз</span>}
          <div className="spacer" />
          {rows.length > 0 && <>
            <button className="btn sm" disabled={busy} onClick={() => fileInput.current?.click()}>Загрузить из Excel</button>
            <button className="btn sm ghost" onClick={() => downloadFile(templateWorkbook(departments), "цели-шаблон.xlsx")}>
              Скачать шаблон
            </button>
          </>}
          {broken > 0 && (
            <button className="btn sm ghost" onClick={() => setRows((prev) => prev.filter((r) => !hasErrors(issues.get(r.key))))}>
              Убрать строки с ошибками
            </button>
          )}
          {batch && (
            <button className="btn sm" onClick={() => downloadFile(resultsWorkbook(batch.rows, batch.result), "результат-проверки.xlsx")}>
              Скачать Excel
            </button>
          )}
          {(batch || (rows.length > 0 && !busy)) && (
            <button className="btn sm menu-btn" id="batchMenu" aria-haspopup="menu" aria-label="Ещё" title="Ещё"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => openMenu(e.currentTarget, menuItems())}>⋯</button>
          )}
        </div>
        {current ? (
          <div className="batch-split">
            <BatchList rows={rows} current={current.key} issues={issues} outcomeOf={outcomeOf} checked={checked} live={batchRun.live?.items}
              names={names} fallbackName={fallbackName} onSelect={setSelected} onAdd={add} />
            <BatchDetail key={current.key} row={current} index={currentIndex} issues={issues.get(current.key)}
              outcome={outcomeOf(current)} result={checked.get(current.key)?.result} live={batchRun.live?.items[current.key]}
              options={options} fallbackName={fallbackName} onPatch={patch} onRemove={remove}
              verdict={verdictProps} autoFocus={current.key === added} />
          </div>
        ) : (
          // Пусто: зона, куда перетаскивают файл Excel или вставляют строки из таблицы (Ctrl+V).
          <div className={`batch-empty drop ${dragging ? "over" : ""}`} id="batchDrop" tabIndex={0}
            aria-label="Зона загрузки: перетащите книгу или вставьте строки"
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) void openFile(f); }}
            onPaste={(e) => { e.preventDefault(); paste(e.clipboardData.getData("text/plain")); }}>
            <span className="drop-ico" aria-hidden="true">
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10 13V3M6 7l4-4 4 4M3 13v3a1 1 0 001 1h12a1 1 0 001-1v-3" /></svg>
            </span>
            <b>Перетащите файл Excel сюда</b>
            <span className="muted">или щёлкните здесь и вставьте строки из таблицы через Ctrl+V</span>
            <div className="row">
              <button className="btn primary" disabled={busy} onClick={() => fileInput.current?.click()}>Выбрать файл</button>
              <button className="btn" onClick={() => downloadFile(templateWorkbook(departments), "цели-шаблон.xlsx")}>Скачать шаблон</button>
              <button className="btn ghost" onClick={add}>+ Добавить цель</button>
            </div>
            <span className="dim">.xlsx, до {MAX_ROWS} целей за раз</span>
          </div>
        )}
      </div>
    </>
  );

  function menuItems(): MenuItem[] {
    const items: MenuItem[] = [];
    if (batch) {
      items.push({ label: "Показать ответ API (JSON)", run: () => openCustom((close) => <JsonDialog id="batchJson" value={batch.result} close={close} />) });
      items.push({ label: "Скопировать ответ API (JSON)", run: async () => {
        if (await copyText(JSON.stringify(batch.result, null, 2))) toast("JSON скопирован", "ok");
        else toast("Не удалось скопировать — откройте ответ API и скопируйте вручную", "err");
      } });
    }
    if (rows.length && !busy) {
      if (items.length) items.push(null);
      items.push({ label: "Очистить список", danger: true, run: () => { setRows(() => []); setCheckForm({ batch: null }); } });
    }
    return items;
  }
}

/** Сводка ответа в шапке: только ненулевые счётчики. Непроверенные цели (unchecked) — отдельно, не в «ручной проверке». */
function BatchSummary({ batch }: { batch: BatchSnapshot }) {
  const s = useMemo(() => summaryOf(batch.result.results), [batch]);
  const parts: [string, number, string, string?][] = [
    ["ok", s.allowed, "без нарушений"],
    ["err", s.violations, "нужно доработать"],
    ["warn", s.manual_review, "ручная проверка"],
    ["", s.unchecked ?? 0, "не проверено", "batchUnchecked"],
  ];
  return (
    <span className="batch-sum" id="batchSummary" data-checked={s.total - (s.unchecked ?? 0)}>
      {parts.filter(([, n]) => n > 0).map(([cls, n, label, id]) => (
        <span key={label} id={id} title={id ? "Пакет не дошёл до этих целей: они не проверены, отправьте их снова" : undefined}>
          <i className={`st-dot ${cls}`} /><b>{n}</b> {label}
        </span>
      ))}
    </span>
  );
}

type Checked = Map<string, { row: BatchRow; result: CheckResult | undefined }>;

/** Что показать о строке в списке: текст и цвет точки. Пока ответа части нет, статус берётся из хода пакета. */
function statusOf(outcome: Outcome, result: CheckResult | undefined, broken: boolean,
  live: BatchItemProgress | undefined): { cls: string; text: string } {
  if (broken) return { cls: "err", text: "ошибка в строке" };
  if (!outcome && live?.status === "queued") return { cls: "none", text: "в очереди" };
  if (!outcome && live?.status === "running")
    return { cls: "run", text: `проверяется…${live.seconds != null ? " " + seconds(live.seconds) : ""}` };
  if (!outcome && live?.status === "done" && live.verdict) outcome = live.verdict;
  switch (outcome) {
    case "stale": return { cls: "", text: "изменено, не проверено" };
    case "unchecked": return { cls: "", text: "не проверено, отправьте снова" };
    case "failed": return { cls: "warn", text: "сбой, отправьте снова" };
    case "NEEDS_MANUAL_REVIEW": return { cls: "warn", text: "ручная проверка" };
    case "ALLOWED": return { cls: "ok", text: "нарушений нет" };
    case "VIOLATIONS_FOUND": {
      const rules = result ? new Set(result.violations.map(ruleKey)).size : 0;
      return { cls: "err", text: rules ? `нарушено правил: ${rules}` : "нужно доработать" };
    }
    default: return { cls: "none", text: "" };
  }
}

interface ListProps {
  rows: BatchRow[];
  current: string;
  issues: Map<string, Issue[]>;
  outcomeOf: (row: BatchRow) => Outcome;
  checked: Checked;
  live: Record<string, BatchItemProgress> | undefined;
  names: Map<string, string>;
  fallbackName: string | undefined;
  onSelect: (key: string) => void;
  onAdd: () => void;
}

/** Список целей: номер, начало формулировки, подразделение и статус. Стрелки ходят по списку. */
function BatchList({ rows, current, issues, outcomeOf, checked, live, names, fallbackName, onSelect, onAdd }: ListProps) {
  const list = useRef<HTMLOListElement>(null);
  function onKey(event: KeyboardEvent<HTMLOListElement>) {
    const step = ({ ArrowDown: 1, ArrowUp: -1 } as Record<string, number>)[event.key];
    if (!step) return;
    event.preventDefault();
    const at = rows.findIndex((r) => r.key === current);
    const next = rows[Math.min(rows.length - 1, Math.max(0, at + step))];
    onSelect(next.key);
    requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`[data-key="${next.key}"]`)?.focus());
  }
  return (
    <div className="batch-side">
      <ol className="batch-list" ref={list} onKeyDown={onKey} aria-label="Цели">
        {rows.map((row, i) => {
          const department = row.departmentId ? names.get(row.departmentId) ?? row.departmentId
            : fallbackName ?? "без подразделения";
          const outcome = outcomeOf(row);
          const item = live?.[row.key];
          return (
            <BatchListItem key={row.key} row={row} index={i} active={row.key === current} department={department}
              status={statusOf(outcome, checked.get(row.key)?.result, hasErrors(issues.get(row.key)), item)}
              time={outcome !== "stale" ? timeOf(item) : ""} onSelect={onSelect} />
          );
        })}
      </ol>
      <button className="batch-add" onClick={onAdd}>+ Добавить цель</button>
    </div>
  );
}

/** Пункт списка перерисовывается, только когда меняется он сам: ввод в одной цели не трогает остальные сотни. */
const BatchListItem = memo(function BatchListItem({ row, index, active, department, status, time, onSelect }: {
  row: BatchRow; index: number; active: boolean; department: string;
  status: { cls: string; text: string }; time: string; onSelect: (key: string) => void;
}) {
  return (
    <li data-row={index + 1}>
      <button type="button" data-key={row.key} aria-current={active} tabIndex={active ? 0 : -1} onClick={() => onSelect(row.key)}>
        <span className="n">{index + 1}</span>
        <span className={`g${row.goal.trim() ? "" : " blank"}`}>{row.goal.trim() || "Формулировка не заполнена"}</span>
        <span className="m">
          <i className={`st-dot ${status.cls}`} />
          <span className="dep">{department}{row.isStudent ? " · студент" : ""}</span>
          {status.text && <span className={`s ${status.cls}`}>{status.text}</span>}
          {time && <span className="t" title={time === "кэш" ? "Ответ из кэша" : "Сколько проверялась цель"}>{time}</span>}
        </span>
      </button>
    </li>
  );
}, (a, b) => a.row === b.row && a.index === b.index && a.active === b.active && a.department === b.department
  && a.status.cls === b.status.cls && a.status.text === b.status.text && a.time === b.time && a.onSelect === b.onSelect);

/** Сколько проверялась готовая цель: «2,9 с» или «кэш». */
const timeOf = (item: BatchItemProgress | undefined) =>
  item?.status !== "done" || item.seconds == null ? "" : item.cached ? "кэш" : seconds(item.seconds);

type Catalog = ReturnType<typeof useCatalog>;

interface VerdictProps {
  totalFor: (departmentId: string | null, isStudent: boolean | null) => number;
  onTrace: (result: CheckResult) => void;
  onAttribute: (name: string) => void;
  onDispute?: (result: CheckResult, attribute: string) => void;
}

interface DetailProps {
  row: BatchRow;
  index: number;
  issues: Issue[] | undefined;
  outcome: Outcome;
  result: CheckResult | undefined;
  /** Ход цели в идущем или последнем пакете. */
  live: BatchItemProgress | undefined;
  options: SelectOption[];
  fallbackName: string | undefined;
  onPatch: (key: string, change: Partial<BatchRow>) => void;
  onRemove: (key: string) => void;
  verdict: VerdictProps;
  autoFocus: boolean;
}

/** Выбранная цель: её поля и разбор — как у одиночной проверки, пока ответ относится к строке. */
function BatchDetail({ row, index, issues, outcome, result, live, options, fallbackName, onPatch, onRemove, verdict, autoFocus }: DetailProps) {
  const known = options.some((o) => o.value === row.departmentId);
  const rowOptions = useMemo(() => [
    { value: "", label: fallbackName ? `По умолчанию (${fallbackName})` : "Не указано" },
    ...(row.departmentId && !known ? [{ value: row.departmentId, label: `${row.departmentId} — нет в справочнике` }] : []),
    ...options,
  ], [options, fallbackName, row.departmentId, known]);
  const n = index + 1;
  const note = outcome === "stale" ? "Цель изменили после проверки: прежний ответ к ней не относится. Проверьте её снова."
    : outcome === "unchecked" ? "Пакет не уложился в отведённое время: цель не проверена. «Проверить оставшиеся» отправит её снова."
    : outcome === "failed" ? "Проверка сорвалась из-за временного сбоя. «Проверить оставшиеся» отправит цель снова."
    : !outcome && !live ? "Цель ещё не проверялась." : null;
  const time = outcome !== "stale" ? timeOf(live) : "";
  return (
    <section className="batch-detail" aria-label={`Разбор цели ${n}`} data-detail={n}>
      <div className="row batch-detail-head">
        <span className="dim">Цель {n}</span>
        <div className="spacer" />
        <button className="btn sm ghost" aria-label={`Удалить строку ${n}`} title="Удалить цель" onClick={() => onRemove(row.key)}>Удалить</button>
      </div>
      <textarea rows={3} value={row.goal} aria-label={`Цель ${n}`} autoFocus={autoFocus} placeholder="Формулировка цели"
        onChange={(e) => onPatch(row.key, { goal: e.target.value })} />
      <Issues items={issues ?? []} />
      <div className="batch-fields">
        <div>
          <div className="lbl">Подразделение</div>
          <Select ariaLabel={`Подразделение ${n}`} value={row.departmentId}
            onChange={(next) => onPatch(row.key, { departmentId: next })} options={rowOptions} />
        </div>
        <div>
          <div className="lbl">Идентификатор</div>
          <input type="text" value={row.id} aria-label={`Идентификатор ${n}`} placeholder="необязательно"
            onChange={(e) => onPatch(row.key, { id: e.target.value })} />
        </div>
        <label className="check" title="Цель ставит студент: проверяются и правила только для студентов">
          <input type="checkbox" checked={row.isStudent} aria-label={`Студент ${n}`}
            onChange={(e) => onPatch(row.key, { isStudent: e.target.checked, studentText: undefined })} /> Цель студента
        </label>
      </div>
      {note && <div className={outcome === "failed" ? "alert batch-note" : "dim batch-note"}>{note}</div>}
      {!outcome && live && live.status !== "done" && <div className="batch-note"><RowLive item={live} /></div>}
      {!outcome && live?.status === "done" && <div className="dim batch-note">Цель проверена, разбор появится с ответом части пакета.</div>}
      {result && !note && time && <div className="dim batch-time">{time === "кэш" ? "Ответ из кэша" : `Проверялась ${time}`}</div>}
      {!note && result && (
        <Verdict result={result} total={verdict.totalFor(result.department?.id ?? null, result.is_student)}
          onTrace={() => verdict.onTrace(result)} onAttribute={verdict.onAttribute}
          onDispute={verdict.onDispute && result.status !== "NEEDS_MANUAL_REVIEW"
            ? (attribute) => verdict.onDispute!(result, attribute) : undefined} />
      )}
    </section>
  );
}

/** Обработчики вердикта: сколько правил проверялось, переход на граф и в словарь, «Не согласен». */
function useVerdictProps({ orders, targets, setSection, setTrace, goToNode }: Pick<Catalog,
  "orders" | "targets" | "setSection" | "setTrace" | "goToNode">, canEdit: boolean,
  openAdvice: ReturnType<typeof useAdviceDialog>): VerdictProps {
  // Сколько правил проверяется для подразделения и студента — та же логика, что в графе и у одиночной проверки.
  const active = useMemo(() => activeRuleRefs(orders), [orders]);
  return {
    totalFor: (departmentId, isStudent) =>
      active.filter(({ rule }) => ruleApplies(rule, departmentId, isStudent !== false)).length,
    onTrace: (result) => { setTrace(result); setSection("graph"); },
    onAttribute: (name) => {
      const target = targets.find((t) => t.name === name);
      if (target) void goToNode(target.nodeId, "CheckTarget");
      else setSection("targets");
    },
    onDispute: canEdit
      ? (result, attribute) => openAdvice({ result, departmentId: result.department?.id ?? null, attribute, onApplied: () => undefined })
      : undefined,
  };
}

function Issues({ items }: { items: Issue[] }) {
  if (!items.length) return null;
  return (
    <div className="row-issues">
      {items.map((issue, i) => <span key={i} className={issue.level}>{issue.text}</span>)}
    </div>
  );
}

/* ------------------------- форма проверки файла --------------------------- */

interface ImportProps {
  file: string;
  sheets: WorkbookSheet[];
  departments: Department[];
  /** Подразделение, выбранное на странице: предлагается строкам, где его нет. */
  fallback: string;
  onImport: (rows: BatchRow[]) => void;
  close: () => void;
}

/** Что нашлось в файле и что с этим не так — до того, как строки попадут в таблицу. */
function ImportDialog({ file, sheets, departments, fallback, onImport, close }: ImportProps) {
  const [sheetIndex, setSheetIndex] = useState(0);
  // Разбирается только выбранный лист и не дальше SHEET_MAX_ROWS строк: огромный лист
  // рядом с листом целей не вешает страницу, а слишком длинный отклоняется понятным сообщением.
  const [loaded, setLoaded] = useState<{ index: number; sheet?: Sheet; error?: string } | null>(null);
  useEffect(() => {
    let alive = true;
    (sheets[sheetIndex] ?? sheets[0]).read(SHEET_MAX_ROWS).then(
      (sheet) => { if (alive) setLoaded({ index: sheetIndex, sheet }); },
      (err) => { if (alive) setLoaded({ index: sheetIndex,
        error: err instanceof XlsxError ? err.message : "Не удалось прочитать лист: " + errorText(err) }); });
    return () => { alive = false; };
  }, [sheets, sheetIndex]);
  const current = loaded?.index === sheetIndex ? loaded : null;

  const sheetPicker = sheets.length > 1 ? (
    <div className="field">
      <label htmlFor="importSheet">Лист</label>
      <Select id="importSheet" value={String(sheetIndex)} onChange={(v) => setSheetIndex(Number(v))}
        options={sheets.map((s, i) => ({ value: String(i), label: s.name }))} />
    </div>
  ) : null;
  return (
    <Overlay onClose={close}>
      <div className="modal wide" role="dialog" aria-modal="true" aria-label="Загрузка целей из Excel">
        <h3>Загрузка целей из Excel</h3>
        {/* Смена листа начинает разбор заново: столбцы угадываются по его заголовку. */}
        {current?.sheet ? (
          <ImportForm key={sheetIndex} file={file} sheet={current.sheet} departments={departments} fallback={fallback}
            close={close} onImport={onImport} sheetPicker={sheetPicker} />
        ) : (
          <>
            <div className="content">
              {sheetPicker}
              {current?.error
                ? <div className="alert danger" id="importError">{current.error}</div>
                : <div className="dim"><Spinner /> Читаем лист…</div>}
            </div>
            <div className="foot"><button type="button" className="btn" onClick={close}>Отмена</button></div>
          </>
        )}
      </div>
    </Overlay>
  );
}

const PREVIEW_ROWS = 5;
const SHOWN_ISSUES = 30;

function ImportForm({ file, sheet, departments, fallback, sheetPicker, onImport, close }: Omit<ImportProps, "sheets"> & {
  sheet: Sheet; sheetPicker: React.ReactNode;
}) {
  const { goalMaxChars } = useAuth();
  const detected = useMemo(() => detectColumns(sheet.rows), [sheet]);
  const [header, setHeader] = useState(detected.header);
  const [columns, setColumns] = useState<Columns>(detected.columns);
  const [defaultDepartment, setDefaultDepartment] = useState(fallback);
  const [skipBroken, setSkipBroken] = useState(false);

  const width = useMemo(() => sheetWidth(sheet.rows), [sheet]);
  const head = sheet.rows[0] ?? [];
  // В списке — только столбцы, где есть хоть одно значение: одинокая ячейка в столбце XFD
  // не превращает выбор в список из 16 тысяч пунктов.
  const used = useMemo(() => {
    const seen = new Set<number>();
    for (const cells of sheet.rows) cells?.forEach((c, i) => { if (c) seen.add(i); });
    return [...seen].sort((a, b) => a - b);
  }, [sheet]);
  const listed = [...new Set([...used, ...[columns.goal, columns.department, columns.id, columns.student]
    .filter((c): c is number => c !== null && c < width)])].sort((a, b) => a - b);
  const columnOptions = [{ value: "", label: "нет такого столбца" }, ...listed.map((i) => ({
    value: String(i), label: `${columnName(i)}${header && head[i] ? ` — ${head[i]}` : ""}`,
  }))];
  const setColumn = (name: keyof Columns, value: string) => setColumns((c) => ({ ...c, [name]: value === "" ? null : Number(value) }));

  const rows = useMemo(() => {
    const parsed = rowsFromSheet(sheet, columns, header, departments);
    // Подразделение по умолчанию записывается в строку явно: после загрузки оно видно в таблице.
    return defaultDepartment ? parsed.map((r) => (r.departmentId ? r : { ...r, departmentId: defaultDepartment })) : parsed;
  }, [sheet, columns, header, departments, defaultDepartment]);
  const issues = useMemo(() => validateRows(rows, departments, "", goalMaxChars), [rows, departments, goalMaxChars]);
  const brokenRows = rows.filter((r) => hasErrors(issues.get(r.key)));
  const warnings = [...issues.values()].flat().filter((i) => i.level === "warning").length;
  const toImport = skipBroken ? rows.filter((r) => !hasErrors(issues.get(r.key))) : rows;
  const tooMany = toImport.length > MAX_ROWS;
  const noGoalColumn = columns.goal === null;

  const list = rows.flatMap((r) => (issues.get(r.key) ?? []).map((issue) => ({ line: r.line, issue })));

  return (
    <>
      <div className="content">
        <div className="dim" style={{ marginBottom: 12 }}>{file} · лист «{sheet.name}» · {plural(sheet.rows.length, ["строка", "строки", "строк"])}</div>
        {sheetPicker}
        <div className="field">
          <label className="check">
            <input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} /> Первая строка — заголовки
          </label>
        </div>
        <div className="import-cols">
          <div className="field">
            <label htmlFor="importGoal">Столбец с целью</label>
            <Select id="importGoal" value={columns.goal === null ? "" : String(columns.goal)} options={columnOptions}
              onChange={(v) => setColumn("goal", v)} />
          </div>
          <div className="field">
            <label htmlFor="importDepartment">Столбец с подразделением</label>
            <Select id="importDepartment" value={columns.department === null ? "" : String(columns.department)} options={columnOptions}
              onChange={(v) => setColumn("department", v)} />
            <div className="hint">Идентификатор или название из справочника.</div>
          </div>
          <div className="field">
            <label htmlFor="importId">Столбец с идентификатором</label>
            <Select id="importId" value={columns.id === null ? "" : String(columns.id)} options={columnOptions}
              onChange={(v) => setColumn("id", v)} />
          </div>
          <div className="field">
            <label htmlFor="importStudent">Столбец «Студент»</label>
            <Select id="importStudent" value={columns.student === null ? "" : String(columns.student)} options={columnOptions}
              onChange={(v) => setColumn("student", v)} />
            <div className="hint">«да» — цель студента; без столбца все цели считаются целями сотрудников.</div>
          </div>
        </div>
        <div className="field">
          <label htmlFor="importFallback">Подразделение для строк, где оно не указано</label>
          <Select id="importFallback" value={defaultDepartment} onChange={setDefaultDepartment}
            options={[{ value: "", label: "Не подставлять" }, ...departmentOptions(departments)]} />
        </div>

        <div className="import-summary" id="importSummary">
          <span className="badge count">строк: {rows.length}</span>
          <span className={`badge ${brokenRows.length ? "err" : "ok"}`}>с ошибками: {brokenRows.length}</span>
          {warnings > 0 && <span className="badge warn">предупреждений: {warnings}</span>}
        </div>
        {detected.ambiguous.length > 1 && header && columns.goal === detected.columns.goal && (
          <div className="alert" id="importAmbiguous" style={{ marginTop: 10 }}>
            На цель похожи столбцы {detected.ambiguous.map(columnName).join(", ")}: выбран {columnName(detected.columns.goal!)}.
            Проверьте, что это формулировка цели.
          </div>
        )}
        {noGoalColumn && <div className="alert danger" style={{ marginTop: 10 }}>Укажите, в каком столбце формулировка цели.</div>}
        {tooMany && <div className="alert danger" style={{ marginTop: 10 }}>За один раз можно загрузить не более {MAX_ROWS} целей — разбейте файл.</div>}

        {list.length > 0 && (
          <div className="import-issues" id="importIssues">
            {list.slice(0, SHOWN_ISSUES).map(({ line, issue }, i) => (
              <div key={i} className={`issue-line ${issue.level}`}>
                <span className="mono">строка {line}</span> {issue.text}
              </div>
            ))}
            {list.length > SHOWN_ISSUES && <div className="dim">… и ещё {list.length - SHOWN_ISSUES}</div>}
          </div>
        )}
        {brokenRows.length > 0 && (
          <label className="check" style={{ marginTop: 10 }}>
            <input type="checkbox" checked={skipBroken} onChange={(e) => setSkipBroken(e.target.checked)} />
            Пропустить строки с ошибками ({brokenRows.length})
          </label>
        )}

        {rows.length > 0 && !noGoalColumn && (
          <table className="preview-table" style={{ marginTop: 14 }}>
            <thead><tr><th>Строка</th><th>Цель</th><th>Подразделение</th><th>Студент</th><th>Идентификатор</th></tr></thead>
            <tbody>
              {rows.slice(0, PREVIEW_ROWS).map((r) => (
                <tr key={r.key} className={hasErrors(issues.get(r.key)) ? "bad" : ""}>
                  <td className="mono">{r.line}</td>
                  <td>{r.goal || <span className="dim">пусто</span>}</td>
                  <td>{r.departmentId || <span className="dim">не указано</span>}</td>
                  <td>{r.isStudent ? "да" : <span className="dim">нет</span>}</td>
                  <td className="mono">{r.id}</td>
                </tr>
              ))}
              {rows.length > PREVIEW_ROWS && <tr><td colSpan={5} className="dim">… и ещё {rows.length - PREVIEW_ROWS}</td></tr>}
            </tbody>
          </table>
        )}
      </div>
      <div className="foot">
        <button type="button" className="btn" onClick={close}>Отмена</button>
        <button type="button" className="btn primary" disabled={!toImport.length || tooMany || noGoalColumn}
          onClick={() => { onImport(toImport); close(); }}>
          Загрузить {toImport.length ? plural(toImport.length, ["строку", "строки", "строк"]) : ""}
        </button>
      </div>
    </>
  );
}
