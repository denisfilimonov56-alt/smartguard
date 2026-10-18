import { useMemo, useRef, useState, type ChangeEvent } from "react";

import type { BatchCheck as BatchResult, Department } from "../../api/types";
import { columnName, downloadFile, readWorkbook, XlsxError, type Sheet } from "../../lib/xlsx";
import { useAuth } from "../../state/auth";
import { useCatalog, type BatchRow } from "../../state/catalog";
import { cellState } from "../../state/scope";
import { activeRuleRefs } from "../../state/tree";
import { Spinner } from "../../ui/common";
import { Overlay, useDialogs } from "../../ui/Dialogs";
import { Select } from "../../ui/Select";
import { errorText, useToast } from "../../ui/Toasts";
import { useAdviceDialog } from "./AdviceDialog";
import {
  MAX_ROWS, STATUS_CLASS, STATUS_LABEL, detectColumns, emptyRow, hasErrors, plural, resultsWorkbook,
  rowsFromSheet, runBatch, templateWorkbook, validateRows, type Columns, type Issue,
} from "./batch";
import { Verdict } from "./Verdict";

/* Проверка нескольких целей сразу: таблица строк «цель — подразделение —
   идентификатор», которую заполняют вручную или из файла Excel. Перед отправкой
   строки проверяются здесь же: пустая цель, неизвестное подразделение и т. п.
   не дают нажать «Проверить». Ответ — по строке на цель, с развёрнутым
   вердиктом как у одиночной проверки, и выгружается обратно в Excel. */

const MAX_FILE_BYTES = 10 * 1024 * 1024;

const departmentOptions = (departments: Department[]) =>
  departments.filter((d) => d.departmentId && d.status === "active")
    .map((d) => ({ value: d.departmentId!, label: d.name || d.departmentId! }));

export function BatchCheck() {
  const toast = useToast();
  const { openCustom } = useDialogs();
  const { canEdit } = useAuth();
  const openAdvice = useAdviceDialog();
  const { orders, departments, checkForm, setCheckForm, setSection, setTrace } = useCatalog();
  const { rows, departmentId: fallback, batch } = checkForm;
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const options = departmentOptions(departments);
  const fallbackName = options.find((o) => o.value === fallback)?.label;
  const issues = useMemo(() => validateRows(rows, departments, fallback), [rows, departments, fallback]);
  const broken = rows.filter((r) => hasErrors(issues.get(r.key))).length;
  const tooMany = rows.length > MAX_ROWS;
  const busy = progress !== null;

  const setRows = (update: (prev: BatchRow[]) => BatchRow[]) => setCheckForm((prev) => ({ rows: update(prev.rows) }));
  const patch = (key: string, change: Partial<BatchRow>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...change } : r)));

  // Ответ по строке — пока строки те же, что проверялись.
  const outcomes = useMemo(() => new Map(batch?.rows.map((r, i) => [r.key, batch.result.results[i]])), [batch]);

  // Сколько правил проверяется для подразделения — та же логика, что в графе и у одиночной проверки.
  const active = useMemo(() => activeRuleRefs(orders), [orders]);
  const totalFor = (departmentId: string | null) =>
    active.filter(({ rule }) => !departmentId || cellState(rule, departmentId) !== "off").length;

  async function pick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) { toast("Файл больше 10 МБ: оставьте в нём только лист с целями", "err"); return; }
    let sheets: Sheet[];
    try {
      sheets = await readWorkbook(await file.arrayBuffer());
    } catch (err) {
      toast(err instanceof XlsxError ? err.message : "Не удалось прочитать файл: " + errorText(err), "err");
      return;
    }
    openCustom((close) => (
      <ImportDialog file={file.name} sheets={sheets} departments={departments} fallback={fallback} close={close}
        onImport={(imported) => {
          // Пустые строки-заготовки загруженные вытесняют, заполненные остаются.
          setRows((prev) => [...prev.filter((r) => r.goal.trim() || r.departmentId || r.id), ...imported]);
          setCheckForm({ batch: null });
          toast(`Загружено: ${plural(imported.length, ["строка", "строки", "строк"])}`, "ok");
        }} />
    ));
  }

  async function run() {
    if (!rows.length) { toast("Добавьте хотя бы одну цель", "err"); return; }
    if (broken) { toast("Сначала исправьте строки с ошибками", "err"); return; }
    if (tooMany) { toast(`За один раз можно проверить не более ${MAX_ROWS} целей`, "err"); return; }
    setProgress({ done: 0, total: rows.length });
    setCheckForm({ batch: null });
    const partial: { value: BatchResult | null } = { value: null };
    try {
      const result = await runBatch(rows, fallback, (part) => {
        partial.value = part;
        setProgress({ done: part.results.length, total: rows.length });
      });
      setCheckForm({ batch: { rows, result } });
    } catch (err) {
      // Что успели проверить, не теряется: ответ показывается по проверенным строкам.
      const done = partial.value;
      if (done) setCheckForm({ batch: { rows: rows.slice(0, done.results.length), result: done } });
      toast(`Проверка прервана: ${errorText(err)}${done ? `. Проверено ${done.results.length} из ${rows.length}` : ""}`, "err");
    } finally {
      setProgress(null);
    }
  }

  const dispute = canEdit
    ? (result: BatchResult["results"][number], attribute: string) =>
      openAdvice({ result, departmentId: result.department?.id ?? null, attribute, onApplied: () => undefined })
    : undefined;

  return (
    <>
      <div className="hero">
        <h1>Проверьте несколько целей</h1>
        <div className="hint" style={{ marginTop: 6 }}>
          Заполните таблицу или загрузите файл Excel со столбцами «Цель», «Подразделение» и, если есть,
          «Идентификатор». Подразделение у каждой цели обязательно: без него проверка не отправляется.
        </div>
        <div className="row wrap" style={{ marginTop: 14 }}>
          <input ref={fileInput} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="hidden" aria-label="Файл Excel" onChange={(e) => void pick(e)} />
          <button className="btn" disabled={busy} onClick={() => fileInput.current?.click()}>Загрузить из Excel</button>
          <button className="btn ghost" onClick={() => downloadFile(templateWorkbook(departments), "цели-шаблон.xlsx")}>
            Скачать шаблон
          </button>
          <div className="spacer" />
          <Select id="batchDepartment" ariaLabel="Подразделение для строк без него" className="pill" value={fallback}
            style={{ width: 300 }} onChange={(next) => setCheckForm({ departmentId: next })}
            options={[{ value: "", label: "Подразделение по умолчанию: нет" },
              ...options.map((o) => ({ value: o.value, label: `По умолчанию: ${o.label}` }))]} />
          <button className="btn primary" id="batchRun" disabled={busy} onClick={() => void run()}>
            {busy ? <><Spinner /> Проверено {progress.done} из {progress.total}…</>
              : `Проверить${rows.length ? ` (${rows.length})` : ""}`}
          </button>
        </div>
      </div>

      <div className="card batch-card" id="batchRows" style={{ marginTop: 16 }}>
        <div className="row wrap batch-head">
          <span className="mid">{rows.length ? plural(rows.length, ["цель", "цели", "целей"]) : "Целей пока нет"}</span>
          {broken > 0 && <span className="badge err">с ошибками: {broken}</span>}
          {tooMany && <span className="badge err">не более {MAX_ROWS} целей за раз</span>}
          <div className="spacer" />
          {broken > 0 && (
            <button className="btn sm ghost" onClick={() => setRows((prev) => prev.filter((r) => !hasErrors(issues.get(r.key))))}>
              Убрать строки с ошибками
            </button>
          )}
          {rows.length > 0 && (
            <button className="btn sm ghost" onClick={() => { setRows(() => []); setCheckForm({ batch: null }); }}>Очистить</button>
          )}
          <button className="btn sm" onClick={() => setRows((prev) => [...prev, emptyRow()])}>+ Строка</button>
        </div>
        {rows.length > 0 && (
          <table className="batch-table">
            <thead>
              <tr><th className="n">№</th><th>Цель</th><th>Подразделение</th><th>Идентификатор</th><th className="status">Результат</th><th /></tr>
            </thead>
            <tbody>
              {rows.map((row, i) => {
                const rowIssues = issues.get(row.key) ?? [];
                const outcome = outcomes.get(row.key);
                const known = options.some((o) => o.value === row.departmentId);
                return (
                  <tr key={row.key} className={hasErrors(rowIssues) ? "bad" : ""} data-row={i + 1}>
                    <td className="n">{i + 1}</td>
                    <td className="goal">
                      <textarea rows={2} value={row.goal} aria-label={`Цель ${i + 1}`} placeholder="Формулировка цели"
                        onChange={(e) => patch(row.key, { goal: e.target.value })} />
                      <Issues items={rowIssues} />
                    </td>
                    <td data-label="Подразделение">
                      <Select ariaLabel={`Подразделение ${i + 1}`} value={row.departmentId}
                        onChange={(next) => patch(row.key, { departmentId: next })}
                        options={[
                          { value: "", label: fallbackName ? `По умолчанию (${fallbackName})` : "Не указано" },
                          ...(row.departmentId && !known ? [{ value: row.departmentId, label: `${row.departmentId} — нет в справочнике` }] : []),
                          ...options,
                        ]} />
                    </td>
                    <td data-label="Идентификатор">
                      <input type="text" value={row.id} aria-label={`Идентификатор ${i + 1}`} placeholder="необязательно"
                        onChange={(e) => patch(row.key, { id: e.target.value })} />
                    </td>
                    <td className="status" data-label="Результат">
                      {outcome && <span className={`badge ${STATUS_CLASS[outcome.status]}`}>{STATUS_LABEL[outcome.status]}</span>}
                    </td>
                    <td className="x">
                      <button className="close-x" aria-label={`Удалить строку ${i + 1}`} title="Удалить строку"
                        onClick={() => setRows((prev) => prev.filter((r) => r.key !== row.key))}>×</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {batch && (
        <div className="card verdict" id="batchResult" style={{ marginTop: 16 }}>
          <div className="row wrap" style={{ paddingBottom: 12 }}>
            <span className="badge count">Проверено целей: {batch.result.summary.total}</span>
            <span className="badge ok">нарушений нет: {batch.result.summary.allowed}</span>
            <span className="badge err">нужно доработать: {batch.result.summary.violations}</span>
            <span className="badge warn">ручная проверка: {batch.result.summary.manual_review}</span>
            <div className="spacer" />
            <button className="btn sm" onClick={() => downloadFile(resultsWorkbook(batch.rows, batch.result), "результат-проверки.xlsx")}>
              Скачать Excel
            </button>
          </div>
          {batch.result.results.map((result, i) => (
            <details key={batch.rows[i]?.key ?? i} className="batch-item">
              <summary>
                <span className={`badge ${STATUS_CLASS[result.status]}`}>{STATUS_LABEL[result.status]}</span>
                {result.id && <span className="mono">{result.id}</span>}
                <span className="goal">{result.goal}</span>
                <span className="dim">{result.department ? result.department.name || result.department.id : "подразделение не определено"}
                  {result.violations.length ? ` · нарушений: ${result.violations.length}` : ""}</span>
              </summary>
              <Verdict result={result} total={totalFor(result.department?.id ?? null)}
                onTrace={() => { setTrace(result); setSection("graph"); }}
                onDispute={dispute && result.status !== "NEEDS_MANUAL_REVIEW" ? (attribute) => dispute(result, attribute) : undefined} />
            </details>
          ))}
        </div>
      )}
    </>
  );
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
  sheets: Sheet[];
  departments: Department[];
  /** Подразделение, выбранное на странице: предлагается строкам, где его нет. */
  fallback: string;
  onImport: (rows: BatchRow[]) => void;
  close: () => void;
}

/** Что нашлось в файле и что с этим не так — до того, как строки попадут в таблицу. */
function ImportDialog({ file, sheets, departments, fallback, onImport, close }: ImportProps) {
  const [sheetIndex, setSheetIndex] = useState(0);
  const sheet = sheets[sheetIndex] ?? sheets[0];
  return (
    <Overlay onClose={close}>
      <div className="modal wide" role="dialog" aria-label="Загрузка целей из Excel">
        <h3>Загрузка целей из Excel</h3>
        {/* Смена листа начинает разбор заново: столбцы угадываются по его заголовку. */}
        <ImportForm key={sheetIndex} file={file} sheet={sheet} departments={departments} fallback={fallback} close={close}
          onImport={onImport}
          sheetPicker={sheets.length > 1 ? (
            <div className="field">
              <label htmlFor="importSheet">Лист</label>
              <Select id="importSheet" value={String(sheetIndex)} onChange={(v) => setSheetIndex(Number(v))}
                options={sheets.map((s, i) => ({ value: String(i), label: `${s.name} — ${plural(s.rows.length, ["строка", "строки", "строк"])}` }))} />
            </div>
          ) : null} />
      </div>
    </Overlay>
  );
}

const PREVIEW_ROWS = 5;
const SHOWN_ISSUES = 30;

function ImportForm({ file, sheet, departments, fallback, sheetPicker, onImport, close }: Omit<ImportProps, "sheets"> & {
  sheet: Sheet; sheetPicker: React.ReactNode;
}) {
  const detected = useMemo(() => detectColumns(sheet.rows), [sheet]);
  const [header, setHeader] = useState(detected.header);
  const [columns, setColumns] = useState<Columns>(detected.columns);
  const [defaultDepartment, setDefaultDepartment] = useState(fallback);
  const [skipBroken, setSkipBroken] = useState(false);

  const width = Math.max(0, ...sheet.rows.map((r) => r.length));
  const head = sheet.rows[0] ?? [];
  const columnOptions = [{ value: "", label: "нет такого столбца" }, ...Array.from({ length: width }, (_, i) => ({
    value: String(i), label: `${columnName(i)}${header && head[i] ? ` — ${head[i]}` : ""}`,
  }))];
  const setColumn = (name: keyof Columns, value: string) => setColumns((c) => ({ ...c, [name]: value === "" ? null : Number(value) }));

  const rows = useMemo(() => {
    const parsed = rowsFromSheet(sheet, columns, header, departments);
    // Подразделение по умолчанию записывается в строку явно: после загрузки оно видно в таблице.
    return defaultDepartment ? parsed.map((r) => (r.departmentId ? r : { ...r, departmentId: defaultDepartment })) : parsed;
  }, [sheet, columns, header, departments, defaultDepartment]);
  const issues = useMemo(() => validateRows(rows, departments, ""), [rows, departments]);
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
            <thead><tr><th>Строка</th><th>Цель</th><th>Подразделение</th><th>Идентификатор</th></tr></thead>
            <tbody>
              {rows.slice(0, PREVIEW_ROWS).map((r) => (
                <tr key={r.key} className={hasErrors(issues.get(r.key)) ? "bad" : ""}>
                  <td className="mono">{r.line}</td>
                  <td>{r.goal || <span className="dim">пусто</span>}</td>
                  <td>{r.departmentId || <span className="dim">не указано</span>}</td>
                  <td className="mono">{r.id}</td>
                </tr>
              ))}
              {rows.length > PREVIEW_ROWS && <tr><td colSpan={4} className="dim">… и ещё {rows.length - PREVIEW_ROWS}</td></tr>}
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
