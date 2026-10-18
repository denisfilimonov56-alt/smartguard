/* Чтение и запись книг Excel (.xlsx) без сторонних библиотек.

   .xlsx — это ZIP-архив с XML-файлами (Office Open XML). Для пакетной проверки
   целей нужны только текстовые значения ячеек, поэтому здесь ровно столько
   формата, сколько для этого требуется:
     чтение — список листов, общие строки (sharedStrings), строки ячеек;
     запись — книга с несколькими листами, заголовком жирным и переносом текста.
   Сжатые записи архива распаковывает сам браузер (DecompressionStream),
   записываются файлы без сжатия: они маленькие, зато формат проще.
   Библиотека вроде SheetJS весила бы в разы больше всего интерфейса,
   а серверу без интернета новые зависимости ни к чему. */

export class XlsxError extends Error {}

export interface Sheet {
  name: string;
  /** Строки сверху вниз; пустые ячейки — пустые строки, хвост пустых строк отрезан. */
  rows: string[][];
}

/** Значение ячейки при записи: текст, число или пустая ячейка. */
export type CellValue = string | number | null | undefined;

export interface SheetToWrite {
  name: string;
  /** Первая строка — заголовок: записывается жирным. */
  rows: CellValue[][];
  /** Ширина столбцов в символах; без неё — по умолчанию Excel. */
  widths?: number[];
}

/* ------------------------------- ZIP ------------------------------------- */

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
}

/** Больше этого одна часть книги не распаковывается: лист целей столько не весит,
    а архив на 10 МБ может развернуться в сотни мегабайт XML. */
const MAX_PART_BYTES = 64 * 1024 * 1024;
/** Пределы листа Excel: строк и столбцов больше не бывает, а адрес r="99999999" иначе подвесил бы разбор. */
const EXCEL_MAX_ROWS = 1_048_576;
const EXCEL_MAX_COLS = 16_384;
/** Больше ячеек одно объединение не разворачивает. */
const MAX_MERGE_CELLS = 100_000;
const ZIP64 = "Слишком большой файл (ZIP64 не поддерживается): оставьте в книге только лист с целями";

function readEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Конец архива — запись End of central directory; после неё может быть комментарий.
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === SIG_END) { end = i; break; }
  }
  if (end < 0) throw new XlsxError("Файл не является книгой Excel (.xlsx)");
  const count = view.getUint16(end + 10, true);
  const directory = view.getUint32(end + 16, true);
  if (count === 0xffff || directory === 0xffffffff) throw new XlsxError(ZIP64);

  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  let p = directory;
  for (let i = 0; i < count; i++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== SIG_CENTRAL)
      throw new XlsxError("Архив книги повреждён");
    const nameLength = view.getUint16(p + 28, true);
    const extraLength = view.getUint16(p + 30, true);
    const commentLength = view.getUint16(p + 32, true);
    const entry = {
      name: decoder.decode(bytes.subarray(p + 46, p + 46 + nameLength)),
      method: view.getUint16(p + 10, true),
      compressedSize: view.getUint32(p + 20, true),
      size: view.getUint32(p + 24, true),
      offset: view.getUint32(p + 42, true),
    };
    // Настоящие размеры и смещение тогда лежат в дополнительном поле ZIP64.
    if (entry.compressedSize === 0xffffffff || entry.size === 0xffffffff || entry.offset === 0xffffffff)
      throw new XlsxError(ZIP64);
    entries.push(entry);
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function extract(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (entry.offset + 30 > bytes.length || view.getUint32(entry.offset, true) !== SIG_LOCAL)
    throw new XlsxError("Архив книги повреждён");
  const start = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true);
  const data = bytes.subarray(start, start + entry.compressedSize);
  const tooBig = () => new XlsxError("Книга слишком большая: оставьте в ней только лист с целями");
  if (entry.size > MAX_PART_BYTES || data.length > MAX_PART_BYTES) throw tooBig();
  if (entry.method === 0) return data;
  if (entry.method !== 8) throw new XlsxError(`Неподдерживаемый способ сжатия в архиве: ${entry.method}`);
  if (typeof DecompressionStream === "undefined")
    throw new XlsxError("Этот браузер не умеет распаковывать .xlsx — обновите его");
  // Распаковка по кускам: размер в заголовке архива можно подделать, поэтому предел
  // проверяется на каждом куске, и «бомба» обрывается, не успев развернуться в памяти.
  const reader = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_PART_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw tooBig();
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof XlsxError) throw err;
    throw new XlsxError("Архив книги повреждён");
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}

/* ------------------------------- чтение ---------------------------------- */

const RELS_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function parseXml(bytes: Uint8Array, what: string): Document {
  const doc = new DOMParser().parseFromString(new TextDecoder().decode(bytes), "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new XlsxError(`Не удалось разобрать ${what}`);
  return doc;
}

const byName = (root: Document | Element, name: string) => [...root.getElementsByTagNameNS("*", name)];

/** Текст ячейки с форматированием: все <t>, кроме фонетических подсказок <rPh>. */
function richText(element: Element): string {
  return byName(element, "t").filter((t) => !t.closest("rPh")).map((t) => t.textContent ?? "").join("");
}

/** Номер столбца по адресу ячейки: A → 0, Z → 25, AA → 26. */
export function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.toUpperCase()) {
    if (ch < "A" || ch > "Z") break;
    n = n * 26 + ch.charCodeAt(0) - 64;
  }
  return n - 1;
}

/** Буквенное имя столбца: 0 → A, 26 → AA. */
export function columnName(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

function cellText(cell: Element, shared: string[]): string {
  const type = cell.getAttribute("t");
  if (type === "inlineStr") return richText(cell);
  const value = byName(cell, "v")[0]?.textContent ?? "";
  if (type === "s") return shared[Number(value)] ?? "";
  if (type === "str" || type === "e") return value;
  // Логическое значение (TRUE, ИСТИНА, флажок) — 1 / 0: так его понимает и столбец «Студент».
  if (type === "b") return value === "1" || value.toLowerCase() === "true" ? "1" : "0";
  // Число: без хвостовых нулей и экспоненты там, где они не нужны (1001 остаётся 1001).
  const n = Number(value);
  return value !== "" && Number.isFinite(n) ? String(n) : value;
}

/** Ячейки диапазона A2:C10 — номера строк и столбцов с нуля; null, если адрес не разобрать. */
function parseRange(ref: string): { r1: number; c1: number; r2: number; c2: number } | null {
  const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/i.exec(ref.trim().replace(/\$/g, ""));
  if (!m) return null;
  const r1 = Number(m[2]) - 1, c1 = columnIndex(m[1]);
  const r2 = m[4] ? Number(m[4]) - 1 : r1, c2 = m[3] ? columnIndex(m[3]) : c1;
  if (r1 < 0 || c1 < 0 || r2 < r1 || c2 < c1) return null;
  return { r1, c1, r2, c2 };
}

/** Строки листа. maxRows — сколько строк с данными допустимо: дальше разбор останавливается с понятной ошибкой. */
function parseSheet(doc: Document, shared: string[], name: string, maxRows: number): string[][] {
  const limit = Math.min(maxRows, EXCEL_MAX_ROWS);
  const rows: string[][] = [];
  let rowIndex = 0;
  for (const row of byName(doc, "row")) {
    const r = Number(row.getAttribute("r"));
    rowIndex = Number.isInteger(r) && r > 0 ? r - 1 : rowIndex;
    if (rowIndex >= EXCEL_MAX_ROWS) throw new XlsxError(`Лист «${name}» повреждён: номер строки ${rowIndex + 1} больше, чем бывает в Excel`);
    const cells: string[] = [];
    let col = 0;
    for (const cell of byName(row, "c")) {
      const ref = cell.getAttribute("r");
      col = ref && columnIndex(ref) >= 0 ? columnIndex(ref) : col;
      if (col >= EXCEL_MAX_COLS) throw new XlsxError(`Лист «${name}» повреждён: столбец ${columnName(col)} дальше, чем бывает в Excel`);
      const text = cellText(cell, shared);
      if (text) {
        while (cells.length < col) cells.push("");
        cells[col] = text;
      }
      col += 1;
    }
    if (cells.length) {
      if (rowIndex >= limit)
        throw new XlsxError(`На листе «${name}» данные идут дальше строки ${limit}: за раз загружается не более `
          + `${limit} строк. Оставьте на листе только цели или разбейте файл`);
      while (rows.length < rowIndex) rows.push([]);
      rows[rowIndex] = cells;
    }
    rowIndex += 1;
  }

  // Объединённые ячейки: значение хранится только в левой верхней, остальные пусты.
  // Подразделение, объединённое на группу целей, разносится по строкам группы.
  // Вправо объединение разворачивается не дальше последнего столбца с данными:
  // «B2:XFD2» иначе дописал бы в строку 16 тысяч ячеек.
  let dataWidth = 0;
  for (const cells of rows) if (cells && cells.length > dataWidth) dataWidth = cells.length;
  for (const merge of byName(doc, "mergeCell")) {
    const range = parseRange(merge.getAttribute("ref") ?? "");
    if (!range) continue;
    const value = rows[range.r1]?.[range.c1];
    if (!value) continue;
    const last = Math.min(range.r2, rows.length - 1);
    const right = Math.min(range.c2, dataWidth - 1);
    if ((last - range.r1 + 1) * (right - range.c1 + 1) > MAX_MERGE_CELLS) continue;
    for (let r = range.r1; r <= last; r++) {
      const cells = rows[r];
      // Строки без данных не оживают: объединение «с запасом» вниз не создаёт пустых целей.
      if (!cells?.some((c) => c)) continue;
      for (let c = range.c1; c <= right; c++) {
        if (r === range.r1 && c === range.c1) continue;
        while (cells.length < c) cells.push("");
        if (!cells[c]) cells[c] = value;
      }
    }
  }
  return rows;
}

/** Лист книги: имя известно сразу, строки разбираются по запросу. */
export interface WorkbookSheet {
  name: string;
  /** Разобрать лист; maxRows — предел строк с данными (по умолчанию весь лист Excel). */
  read: (maxRows?: number) => Promise<Sheet>;
}

/** Листы книги по порядку. Принимает содержимое файла .xlsx; листы не разбираются,
    пока их не прочитают: в книге может быть огромный лист рядом с листом целей. */
export async function openWorkbook(data: ArrayBuffer | Uint8Array): Promise<WorkbookSheet[]> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const entries = new Map(readEntries(bytes).map((e) => [e.name.replace(/^\//, ""), e]));
  const part = async (name: string) => {
    const entry = entries.get(name);
    return entry ? extract(bytes, entry) : null;
  };

  const workbookBytes = await part("xl/workbook.xml");
  if (!workbookBytes) throw new XlsxError("В файле нет книги Excel: ожидается .xlsx");
  const workbook = parseXml(workbookBytes, "список листов");

  const relsBytes = await part("xl/_rels/workbook.xml.rels");
  const targets = new Map<string, string>();
  if (relsBytes) {
    for (const rel of byName(parseXml(relsBytes, "связи книги"), "Relationship")) {
      const target = rel.getAttribute("Target") ?? "";
      targets.set(rel.getAttribute("Id") ?? "",
        target.startsWith("/") ? target.slice(1) : "xl/" + target.replace(/^\.\//, ""));
    }
  }

  // Общие строки нужны любому листу, но разбираются один раз и только при первом чтении.
  let shared: Promise<string[]> | null = null;
  const sharedStrings = () => shared ??= part("xl/sharedStrings.xml")
    .then((b) => (b ? byName(parseXml(b, "строки книги"), "si").map(richText) : []));

  const sheets: WorkbookSheet[] = [];
  for (const [i, sheet] of byName(workbook, "sheet").entries()) {
    const id = sheet.getAttributeNS(RELS_NS, "id") ?? sheet.getAttribute("r:id") ?? "";
    const path = targets.get(id) ?? `xl/worksheets/sheet${i + 1}.xml`;
    if (!entries.has(path)) continue; // лист с диаграммой или ссылка наружу
    const name = sheet.getAttribute("name") || `Лист ${i + 1}`;
    sheets.push({
      name,
      read: async (maxRows = EXCEL_MAX_ROWS) => {
        const sheetBytes = await part(path);
        if (!sheetBytes) throw new XlsxError(`Лист «${name}» не найден в книге`);
        return { name, rows: parseSheet(parseXml(sheetBytes, `лист «${name}»`), await sharedStrings(), name, maxRows) };
      },
    });
  }
  if (!sheets.length) throw new XlsxError("В книге нет ни одного листа с данными");
  return sheets;
}

/** Все листы книги сразу — для небольших книг и тестов. */
export async function readWorkbook(data: ArrayBuffer | Uint8Array, maxRows?: number): Promise<Sheet[]> {
  return Promise.all((await openWorkbook(data)).map((s) => s.read(maxRows)));
}

/* -------------------------------- запись --------------------------------- */

const escapeXml = (text: string) =>
  text.replace(/[<>&"]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "\"": "&quot;" })[ch] ?? ch)
    // Управляющие символы в XML недопустимы; табуляция и перевод строки остаются.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

const MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const XML_HEAD = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n";

function sheetXml(sheet: SheetToWrite): string {
  const cols = sheet.widths?.length
    ? "<cols>" + sheet.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("") + "</cols>"
    : "";
  const rows = sheet.rows.map((row, r) => {
    const cells = row.map((value, c) => {
      if (value === null || value === undefined || value === "") return "";
      const ref = columnName(c) + (r + 1);
      // Стили из styles.xml: 1 — жирный заголовок, 2 — перенос текста.
      const style = r === 0 ? 1 : 2;
      if (typeof value === "number" && Number.isFinite(value)) return `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
      const text = escapeXml(String(value));
      const space = /^\s|\s$/.test(text) ? " xml:space=\"preserve\"" : "";
      return `<c r="${ref}" s="${style}" t="inlineStr"><is><t${space}>${text}</t></is></c>`;
    }).join("");
    return `<row r="${r + 1}">${cells}</row>`;
  }).join("");
  return `${XML_HEAD}<worksheet xmlns="${MAIN_NS}">${cols}<sheetData>${rows}</sheetData></worksheet>`;
}

const STYLES = `${XML_HEAD}<styleSheet xmlns="${MAIN_NS}">`
  + "<fonts count=\"2\"><font><sz val=\"11\"/><name val=\"Calibri\"/></font>"
  + "<font><b/><sz val=\"11\"/><name val=\"Calibri\"/></font></fonts>"
  + "<fills count=\"2\"><fill><patternFill patternType=\"none\"/></fill><fill><patternFill patternType=\"gray125\"/></fill></fills>"
  + "<borders count=\"1\"><border><left/><right/><top/><bottom/><diagonal/></border></borders>"
  + "<cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs>"
  + "<cellXfs count=\"3\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/>"
  + "<xf numFmtId=\"0\" fontId=\"1\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyFont=\"1\"/>"
  + "<xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyAlignment=\"1\">"
  + "<alignment vertical=\"top\" wrapText=\"1\"/></xf></cellXfs>"
  + "<cellStyles count=\"1\"><cellStyle name=\"Normal\" xfId=\"0\" builtinId=\"0\"/></cellStyles></styleSheet>";

/** Книга Excel: файл .xlsx как массив байтов. */
export function writeWorkbook(sheets: SheetToWrite[]): Uint8Array {
  if (!sheets.length) throw new XlsxError("Книге нужен хотя бы один лист");
  const files: [string, string][] = [
    ["[Content_Types].xml", `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
      + "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>"
      + "<Default Extension=\"xml\" ContentType=\"application/xml\"/>"
      + "<Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/>"
      + "<Override PartName=\"/xl/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\"/>"
      + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" `
        + "ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>").join("")
      + "</Types>"],
    ["_rels/.rels", `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" "
      + "Target=\"xl/workbook.xml\"/></Relationships>"],
    ["xl/workbook.xml", `${XML_HEAD}<workbook xmlns="${MAIN_NS}" xmlns:r="${RELS_NS}"><sheets>`
      + sheets.map((s, i) => `<sheet name="${escapeXml(s.name.slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")
      + "</sheets></workbook>"],
    ["xl/_rels/workbook.xml.rels", `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${RELS_NS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")
      + `<Relationship Id="rId${sheets.length + 1}" Type="${RELS_NS}/styles" Target="styles.xml"/></Relationships>`],
    ["xl/styles.xml", STYLES],
    ...sheets.map((s, i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)]),
  ];
  return zipStore(files.map(([name, text]) => [name, new TextEncoder().encode(text)]));
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of bytes) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** ZIP-архив без сжатия (method 0): файлы маленькие, а читается любой программой. */
function zipStore(files: [string, Uint8Array][]): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  // Дата и время в формате DOS: без них Excel файл открывает, но лучше настоящие.
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  for (const [name, data] of files) {
    const nameBytes = encoder.encode(name);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, SIG_LOCAL, true);
    local.setUint16(4, 20, true);        // нужна версия 2.0
    local.setUint16(6, 0x0800, true);    // имена файлов в UTF-8
    local.setUint16(8, 0, true);         // без сжатия
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, data);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, SIG_CENTRAL, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(10, 0, true);
    entry.setUint16(12, time, true);
    entry.setUint16(14, date, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, nameBytes.length, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }

  const centralSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, SIG_END, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  const out = new Uint8Array(offset + centralSize + 22);
  let p = 0;
  for (const chunk of [...parts, ...central, new Uint8Array(end.buffer)]) { out.set(chunk, p); p += chunk.length; }
  return out;
}

/** Предложить файл для сохранения. */
export function downloadFile(bytes: Uint8Array, filename: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart],
    { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
