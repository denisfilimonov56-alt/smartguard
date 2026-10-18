import { deflateRawSync } from "node:zlib";

/* Книга Excel для тестов загрузки: собирается так, как её пишет сам Excel —
   со сжатием записей архива и общими строками (sharedStrings), то есть
   проверяется настоящий путь чтения в src/lib/xlsx.ts, а не только запись
   без сжатия, которую интерфейс использует для шаблона. */

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes: Buffer) => {
  let crc = 0xffffffff;
  for (const b of bytes) crc = CRC[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

/** ZIP-архив со сжатием deflate — как у файлов, сохранённых Excel. */
function zipDeflate(files: [string, string, number?][]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  // Третий элемент — размер, записанный в заголовок вместо настоящего (подделка «бомбы»).
  for (const [name, text, declared] of files) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(text);
    const packed = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(declared ?? data.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    parts.push(local, nameBytes, packed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10); entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(declared ?? data.length, 24); entry.writeUInt16LE(nameBytes.length, 28); entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

/** Книга с одним листом: текст — через sharedStrings, числа — как числа, true/false — логические ячейки
    (так Excel хранит введённые TRUE / ИСТИНА и флажки), пустые ячейки пропущены.
    merges — объединённые диапазоны вида "B2:B4": значение только в левой верхней ячейке, как у Excel.
    bomb — столько байт пробелов дописать в лист, а в заголовке архива указать маленький размер:
    сжимается в десятки килобайт, распаковывается в мегабайты. */
export function workbook(rows: (string | number | boolean | null)[][], sheetName = "Лист1",
  { merges = [], bomb = 0 }: { merges?: string[]; bomb?: number } = {}): Buffer {
  const shared: string[] = [];
  const index = (text: string) => {
    const i = shared.indexOf(text);
    if (i >= 0) return i;
    shared.push(text);
    return shared.length - 1;
  };
  const col = (i: number) => String.fromCharCode(65 + i);
  const sheetRows = rows.map((row, r) => {
    const cells = row.map((value, c) => {
      if (value === null || value === "") return "";
      const ref = `${col(c)}${r + 1}`;
      if (typeof value === "boolean") return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
      return typeof value === "number" ? `<c r="${ref}"><v>${value}</v></c>` : `<c r="${ref}" t="s"><v>${index(value)}</v></c>`;
    }).join("");
    return `<row r="${r + 1}">${cells}</row>`;
  }).join("");
  const main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const rels = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  return zipDeflate([
    ["[Content_Types].xml", "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">"
      + "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>"
      + "<Default Extension=\"xml\" ContentType=\"application/xml\"/>"
      + "<Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/>"
      + "<Override PartName=\"/xl/worksheets/sheet1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>"
      + "<Override PartName=\"/xl/sharedStrings.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml\"/>"
      + "</Types>"],
    ["_rels/.rels", "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">"
      + `<Relationship Id="rId1" Type="${rels}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["xl/workbook.xml", `<workbook xmlns="${main}" xmlns:r="${rels}"><sheets>`
      + `<sheet name="${escape(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">"
      + `<Relationship Id="rId1" Type="${rels}/worksheet" Target="worksheets/sheet1.xml"/>`
      + `<Relationship Id="rId2" Type="${rels}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`],
    ["xl/sharedStrings.xml", `<sst xmlns="${main}" count="${shared.length}" uniqueCount="${shared.length}">`
      + shared.map((s) => `<si><t xml:space="preserve">${escape(s)}</t></si>`).join("") + "</sst>"],
    ["xl/worksheets/sheet1.xml", `<worksheet xmlns="${main}"><sheetData>${sheetRows}</sheetData>`
      + (merges.length ? `<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>` : "")
      + "</worksheet>" + (bomb ? " ".repeat(bomb) : ""), bomb ? 1024 : undefined],
  ]);
}
