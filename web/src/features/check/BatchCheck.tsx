import { memo, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";

import type { BatchCheck as BatchResult, CheckStatus, Department } from "../../api/types";
import { columnName, downloadFile, openWorkbook, XlsxError, type Sheet, type WorkbookSheet } from "../../lib/xlsx";
import { useAuth } from "../../state/auth";
import { useCatalog } from "../../state/catalog";
import { useCheckForm, type BatchRow, type BatchSnapshot } from "../../state/checkForm";
import { ruleApplies } from "../../state/scope";
import { activeRuleRefs } from "../../state/tree";
import { Spinner } from "../../ui/common";
import { Overlay, useDialogs } from "../../ui/Dialogs";
import { Select, type SelectOption } from "../../ui/Select";
import { errorText, useToast } from "../../ui/Toasts";
import { useAdviceDialog } from "./AdviceDialog";
import {
  MAX_ROWS, SHEET_MAX_ROWS, STATUS_CLASS, STATUS_LABEL, detectColumns, emptyRow, hasErrors, plural, resultsWorkbook,
  ruleKey, rowsFromSheet, sheetWidth, templateWorkbook, validateRows, type Columns, type Issue,
} from "./batch";
import { JsonBlock } from "./JsonBlock";
import { Verdict } from "./Verdict";

/* Проверка нескольких целей сразу: таблица строк «цель — подразделение —
   студент — идентификатор», которую заполняют вручную или из файла Excel. Перед отправкой
   строки проверяются здесь же: пустая цель, неизвестное подразделение и т. п.
   не дают нажать «Проверить». Ответ — по строке на цель, с развёрнутым
   вердиктом как у одиночной проверки, и выгружается обратно в Excel.
   Сам пакет идёт в state/checkForm.tsx: уход со страницы его не прерывает. */

const MAX_FILE_BYTES = 10 * 1024 * 1024;

const departmentOptions = (departments: Department[]) =>
  departments.filter((d) => d.departmentId && d.status === "active")
    .map((d) => ({ value: d.departmentId!, label: d.name || d.departmentId! }));

/** Ответ по строке: статус, «изменено после проверки» или ничего (строку не проверяли). */
type Outcome = CheckStatus | "stale" | undefined;

const sameRow = (a: BatchRow, b: BatchRow, fallback: string, checkedFallback: string) =>
  a.goal.trim() === b.goal.trim() && a.isStudent === b.isStudent && a.id.trim() === b.id.trim()
  && (a.departmentId.trim() || fallback) === (b.departmentId.trim() || checkedFallback);

export function BatchCheck() {
  const toast = useToast();
  const { openCustom } = useDialogs();
  const { canEdit, goalMaxChars } = useAuth();
  const openAdvice = useAdviceDialog();
  const { orders, departments, targets, setSection, setTrace, goToNode } = useCatalog();
  const { checkForm, setCheckForm, batchRun } = useCheckForm();
  const { rows, departmentId: fallback, batch } = checkForm;
  const fileInput = useRef<HTMLInputElement>(null);

  const options = useMemo(() => departmentOptions(departments), [departments]);
  const fallbackName = options.find((o) => o.value === fallback)?.label;
  const issues = useMemo(() => validateRows(rows, departments, fallback, goalMaxChars),
    [rows, departments, fallback, goalMaxChars]);
  const broken = rows.filter((r) => hasErrors(issues.get(r.key))).length;
  const tooMany = rows.length > MAX_ROWS;
  const busy = batchRun.running;

  const setRows = useCallback((update: (prev: BatchRow[]) => BatchRow[]) =>
    setCheckForm((prev) => ({ rows: update(prev.rows) })), [setCheckForm]);
  const patch = useCallback((key: string, change: Partial<BatchRow>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...change } : r))), [setRows]);
  const remove = useCallback((key: string) => setRows((prev) => prev.filter((r) => r.key !== key)), [setRows]);

  // Ответ по строке — только пока строка та же, что проверялась: после правки цели,
  // подразделения, признака студента или идентификатора прежний статус к ней не относится.
  const checked = useMemo(() => new Map(batch?.rows.map((r, i) => [r.key, { row: r, result: batch.result.results[i] }])), [batch]);
  const outcomeOf = (row: BatchRow): Outcome => {
    const hit = checked.get(row.key);
    if (!hit?.result) return undefined;
    return sameRow(row, hit.row, fallback, batch!.fallback) ? hit.result.status : "stale";
  };

  async function pick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
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
          toast(`Загружено: ${plural(imported.length, ["строка", "строки", "строк"])}`, "ok");
        }} />
    ));
  }

  function run() {
    if (busy) return;
    if (!rows.length) { toast("Добавьте хотя бы одну цель", "err"); return; }
    if (broken) { toast("Сначала исправьте строки с ошибками", "err"); return; }
    if (tooMany) { toast(`За один раз можно проверить не более ${MAX_ROWS} целей`, "err"); return; }
    void batchRun.start(rows, fallback);
  }

  return (
    <>
      <div className="hero">
        <h1>Проверьте несколько целей</h1>
        <div className="hint" style={{ marginTop: 6 }}>
          Заполните таблицу или загрузите файл Excel со столбцами «Цель», «Подразделение» и, если есть,
          «Идентификатор» и «Студент». Подразделение у каждой цели обязательно: без него проверка не отправляется.
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
          <button className="btn primary" id="batchRun" disabled={busy} onClick={run}>
            {busy ? <><Spinner /> Проверено {batchRun.done} из {batchRun.total}
              {batchRun.waiting !== null ? ` · очередь занята, повтор через ${batchRun.waiting} с` : "…"}</>
              : `Проверить${rows.length ? ` (${rows.length})` : ""}`}
          </button>
          {busy && <button className="btn" id="batchStop" onClick={batchRun.stop}>Остановить</button>}
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
            <button className="btn sm ghost" disabled={busy} onClick={() => { setRows(() => []); setCheckForm({ batch: null }); }}>Очистить</button>
          )}
          <button className="btn sm" onClick={() => setRows((prev) => [...prev, emptyRow()])}>+ Строка</button>
        </div>
        {rows.length > 0 && (
          <table className="batch-table">
            <thead>
              <tr><th className="n">№</th><th>Цель</th><th>Подразделение</th><th className="student">Студент</th><th>Идентификатор</th><th className="status">Результат</th><th /></tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <BatchTableRow key={row.key} row={row} index={i} issues={issues.get(row.key)} outcome={outcomeOf(row)}
                  options={options} fallbackName={fallbackName} onPatch={patch} onRemove={remove} />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {batch && <BatchResults batch={batch} canEdit={canEdit} orders={orders} targets={targets} setSection={setSection}
        setTrace={setTrace} goToNode={goToNode} openAdvice={openAdvice} />}
      {batch && <JsonBlock id="batchJson" value={batch.result} />}
    </>
  );
}

const sameIssues = (a: Issue[] | undefined, b: Issue[] | undefined) =>
  a === b || (!!a && !!b && a.length === b.length && a.every((x, i) => x.level === b[i].level && x.text === b[i].text));

interface RowProps {
  row: BatchRow;
  index: number;
  issues: Issue[] | undefined;
  outcome: Outcome;
  options: SelectOption[];
  fallbackName: string | undefined;
  onPatch: (key: string, change: Partial<BatchRow>) => void;
  onRemove: (key: string) => void;
}

/** Строка таблицы: перерисовывается, только когда меняется она сама, — ввод в одной строке
    не перерисовывает остальные сотни. validateRows каждый раз даёт новые массивы, поэтому
    замечания сравниваются по содержимому. */
const BatchTableRow = memo(function BatchTableRow({ row, index, issues, outcome, options, fallbackName, onPatch, onRemove }: RowProps) {
  const known = options.some((o) => o.value === row.departmentId);
  const rowOptions = useMemo(() => [
    { value: "", label: fallbackName ? `По умолчанию (${fallbackName})` : "Не указано" },
    ...(row.departmentId && !known ? [{ value: row.departmentId, label: `${row.departmentId} — нет в справочнике` }] : []),
    ...options,
  ], [options, fallbackName, row.departmentId, known]);
  const n = index + 1;
  return (
    <tr className={hasErrors(issues) ? "bad" : ""} data-row={n}>
      <td className="n">{n}</td>
      <td className="goal">
        <textarea rows={2} value={row.goal} aria-label={`Цель ${n}`} placeholder="Формулировка цели"
          onChange={(e) => onPatch(row.key, { goal: e.target.value })} />
        <Issues items={issues ?? []} />
      </td>
      <td data-label="Подразделение">
        <Select ariaLabel={`Подразделение ${n}`} value={row.departmentId}
          onChange={(next) => onPatch(row.key, { departmentId: next })} options={rowOptions} />
      </td>
      <td className="student" data-label="Студент">
        <input type="checkbox" checked={row.isStudent} aria-label={`Студент ${n}`}
          title="Цель ставит студент: проверяются и правила только для студентов"
          onChange={(e) => onPatch(row.key, { isStudent: e.target.checked, studentText: undefined })} />
      </td>
      <td data-label="Идентификатор">
        <input type="text" value={row.id} aria-label={`Идентификатор ${n}`} placeholder="необязательно"
          onChange={(e) => onPatch(row.key, { id: e.target.value })} />
      </td>
      <td className="status" data-label="Результат">
        {outcome === "stale"
          ? <span className="badge" title="Строку изменили после проверки: прежний ответ к ней не относится">изменено, не проверено</span>
          : outcome && <span className={`badge ${STATUS_CLASS[outcome]}`}>{STATUS_LABEL[outcome]}</span>}
      </td>
      <td className="x">
        <button className="close-x" aria-label={`Удалить строку ${n}`} title="Удалить строку"
          onClick={() => onRemove(row.key)}>×</button>
      </td>
    </tr>
  );
}, (a, b) => a.row === b.row && a.index === b.index && a.outcome === b.outcome && a.options === b.options
  && a.fallbackName === b.fallbackName && a.onPatch === b.onPatch && a.onRemove === b.onRemove && sameIssues(a.issues, b.issues));

type Catalog = ReturnType<typeof useCatalog>;

interface ResultsProps {
  batch: BatchSnapshot;
  canEdit: boolean;
  orders: Catalog["orders"];
  targets: Catalog["targets"];
  setSection: Catalog["setSection"];
  setTrace: Catalog["setTrace"];
  goToNode: Catalog["goToNode"];
  openAdvice: ReturnType<typeof useAdviceDialog>;
}

/** Ответ пакета. Вердикт строится только у раскрытых целей: у свёрнутого <details> React
    всё равно рендерит содержимое, а сотни вердиктов с анимацией SMART тормозят страницу.
    Ввод в таблицу этот блок не перерисовывает: batch при вводе не меняется. */
const BatchResults = memo(function BatchResults({ batch, canEdit, orders, targets, setSection, setTrace, goToNode, openAdvice }: ResultsProps) {
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  // Новый ответ — всё свёрнуто заново.
  useEffect(() => setOpen(new Set()), [batch]);
  const toggle = (i: number, isOpen: boolean) => setOpen((prev) => {
    if (prev.has(i) === isOpen) return prev;
    const next = new Set(prev);
    if (isOpen) next.add(i); else next.delete(i);
    return next;
  });

  // Сколько правил проверяется для подразделения и студента — та же логика, что в графе и у одиночной проверки.
  const active = useMemo(() => activeRuleRefs(orders), [orders]);
  const totalFor = (departmentId: string | null, isStudent: boolean | null) =>
    active.filter(({ rule }) => ruleApplies(rule, departmentId, isStudent !== false)).length;
  const openAttribute = (name: string) => {
    const target = targets.find((t) => t.name === name);
    if (target) void goToNode(target.nodeId, "CheckTarget");
    else setSection("targets");
  };
  const dispute = canEdit
    ? (result: BatchResult["results"][number], attribute: string) =>
      openAdvice({ result, departmentId: result.department?.id ?? null, attribute, onApplied: () => undefined })
    : undefined;

  return (
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
      {batch.result.results.map((result, i) => {
        const rules = new Set(result.violations.map(ruleKey)).size;
        return (
          <details key={batch.rows[i]?.key ?? i} className="batch-item" onToggle={(e) => toggle(i, e.currentTarget.open)}>
            <summary>
              <span className={`badge ${STATUS_CLASS[result.status]}`}>{STATUS_LABEL[result.status]}</span>
              {result.id && <span className="mono">{result.id}</span>}
              <span className="goal">{result.goal}</span>
              <span className="dim">{result.department ? result.department.name || result.department.id : "подразделение не определено"}
                {result.is_student ? " · студент" : ""}
                {rules ? ` · нарушено правил: ${rules}` : ""}</span>
            </summary>
            {open.has(i) && (
              <Verdict result={result} total={totalFor(result.department?.id ?? null, result.is_student)}
                onTrace={() => { setTrace(result); setSection("graph"); }} onAttribute={openAttribute}
                onDispute={dispute && result.status !== "NEEDS_MANUAL_REVIEW" ? (attribute) => dispute(result, attribute) : undefined} />
            )}
          </details>
        );
      })}
    </div>
  );
});

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
