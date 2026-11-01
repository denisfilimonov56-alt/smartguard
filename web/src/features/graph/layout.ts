/* Раскладка графа колонками слева направо: приказ → пункт → правило → атрибут.
   Каталог — по сути дерево с перекрёстными связями, поэтому колонки читаются
   лучше раскладки силами: видно, что из чего следует, подписи не налезают
   друг на друга, а связи идут в одну сторону.

   Колонку и полосу внутри неё (атрибуты и подразделения делят одну колонку)
   задаёт вызывающий. Здесь — порядок узлов в колонке (по среднему положению
   соседей слева, чтобы связи меньше пересекались) и их высота: узел тянется
   к середине своих соседей, но не наезжает на узлы рядом. Считается за
   O(узлов + связей) на проход — пересчёт при каждом фильтре дешёвый.
   Сторонней библиотеки нет намеренно: сервер без интернета. */

export interface LayoutNode {
  id: string;
  col: number;
  /** Полоса внутри колонки: полосы идут сверху вниз с отступом под подзаголовок. */
  band: number;
  /** Порядок при равенстве: номер приказа, код пункта и т. п. */
  key: string;
  h: number;
}

export interface Box { x: number; y: number; w: number; h: number; col: number; band: number }

export interface Layout {
  /** Центр узла по вертикали и левый край по горизонтали. */
  boxes: Map<string, Box>;
  /** Колонки, где есть узлы, — с положением и шириной. */
  columns: { col: number; x: number; w: number }[];
  /** Верх первого узла каждой полосы: над ним стоит подзаголовок. */
  bands: { col: number; band: number; top: number; count: number }[];
  width: number;
  height: number;
}

const GAP = 10;          // между узлами колонки
const BAND_GAP = 56;     // между полосами — место под подзаголовок
const COL_GAP = 72;      // между колонками — место под изгиб связи
const PASSES = 8;

const collator = new Intl.Collator("ru", { numeric: true });

/** Ближайшие к желаемым высоты при условии «следующий не выше предыдущего плюс отступ»:
    изотоническая регрессия (объединение соседних нарушителей). */
function pack(desired: number[], sep: number[]): number[] {
  // sep[i] — минимальное расстояние между центрами i-1 и i (sep[0] = 0).
  const offset: number[] = [];
  sep.forEach((s, i) => offset.push((offset[i - 1] ?? 0) + s));
  const blocks: { sum: number; n: number }[] = [];
  for (let i = 0; i < desired.length; i++) {
    blocks.push({ sum: desired[i] - offset[i], n: 1 });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1];
      const a = blocks[blocks.length - 2];
      if (a.sum / a.n <= b.sum / b.n) break;
      a.sum += b.sum; a.n += b.n; blocks.pop();
    }
  }
  const out: number[] = [];
  for (const b of blocks) for (let j = 0; j < b.n; j++) out.push(b.sum / b.n + offset[out.length]);
  return out;
}

export function layoutColumns(nodes: LayoutNode[], edges: [string, string][], widths: Record<number, number>): Layout {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const near = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const [a, b] of edges) {
    if (!byId.has(a) || !byId.has(b) || a === b) continue;
    near.get(a)!.push(b); near.get(b)!.push(a);
  }

  const cols = [...new Set(nodes.map((n) => n.col))].sort((a, b) => a - b);
  const columns = new Map<number, LayoutNode[]>(cols.map((c) => [c, []]));
  nodes.forEach((n) => columns.get(n.col)!.push(n));

  // Порядок: первая колонка — по ключу, следующие — по среднему месту соседей в колонках левее.
  const rank = new Map<string, number>();
  for (const c of cols) {
    const list = columns.get(c)!;
    const mean = (n: LayoutNode) => {
      const left = near.get(n.id)!.filter((o) => byId.get(o)!.col < c && rank.has(o)).map((o) => rank.get(o)!);
      return left.length ? left.reduce((s, r) => s + r, 0) / left.length : Infinity;
    };
    const score = new Map(list.map((n) => [n.id, mean(n)]));
    list.sort((a, b) => a.band - b.band || score.get(a.id)! - score.get(b.id)! || collator.compare(a.key, b.key));
    list.forEach((n, i) => rank.set(n.id, i));
  }

  // Высоты: сначала плотно сверху вниз, затем проходы туда-обратно — к середине соседей.
  const y = new Map<string, number>();
  const seps = new Map<number, number[]>();
  for (const c of cols) {
    const list = columns.get(c)!;
    const sep = list.map((n, i) => i === 0 ? 0
      : list[i - 1].h / 2 + n.h / 2 + GAP + (list[i - 1].band !== n.band ? BAND_GAP : 0));
    seps.set(c, sep);
    let at = 0;
    list.forEach((n, i) => { at += sep[i]; y.set(n.id, at); });
  }
  const settle = (c: number) => {
    const list = columns.get(c)!;
    const sep = seps.get(c)!;
    const desired: number[] = [];
    list.forEach((n, i) => {
      const other = near.get(n.id)!.filter((o) => byId.get(o)!.col !== c);
      // Узел без соседей держится сразу за предыдущим, а не остаётся там, где его поставила плотная укладка.
      desired.push(other.length ? other.reduce((s, o) => s + y.get(o)!, 0) / other.length
        : i ? desired[i - 1] + sep[i] : y.get(n.id)!);
    });
    pack(desired, sep).forEach((v, i) => y.set(list[i].id, v));
  };
  for (let pass = 0; pass < PASSES; pass++) {
    cols.slice(1).forEach(settle);
    cols.slice(0, -1).reverse().forEach(settle);
  }

  // Сдвиг к нулю и горизонтальное положение колонок; пустые колонки места не занимают.
  const top = Math.min(...nodes.map((n) => y.get(n.id)! - n.h / 2));
  const placed: Layout["columns"] = [];
  let x = 0;
  for (const c of cols) {
    const w = widths[c] ?? 200;
    placed.push({ col: c, x, w });
    x += w + COL_GAP;
  }
  const colX = new Map(placed.map((p) => [p.col, p]));
  const boxes = new Map<string, Box>();
  for (const n of nodes) {
    const p = colX.get(n.col)!;
    boxes.set(n.id, { x: p.x, w: p.w, y: y.get(n.id)! - top, h: n.h, col: n.col, band: n.band });
  }
  const bands: Layout["bands"] = [];
  for (const c of cols)
    for (const n of columns.get(c)!) {
      const last = bands[bands.length - 1];
      if (last && last.col === c && last.band === n.band) last.count++;
      else bands.push({ col: c, band: n.band, top: boxes.get(n.id)!.y - n.h / 2, count: 1 });
    }
  const height = Math.max(0, ...[...boxes.values()].map((b) => b.y + b.h / 2));
  return { boxes, columns: placed, bands, width: Math.max(0, x - COL_GAP), height };
}
