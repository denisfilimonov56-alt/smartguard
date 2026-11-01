import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api } from "../../api/client";
import type { CheckResult, GraphEdge, GraphNode, NodeKind } from "../../api/types";
import { useCatalog } from "../../state/catalog";
import { attributeTitle, Empty, PageHead, Skeleton, Spinner } from "../../ui/common";
import { errorText } from "../../ui/Toasts";
import { type Box, layoutColumns } from "./layout";

/* Каталог как граф: приказы, пункты, правила, атрибуты, подразделения и
   должностные инструкции со связями между ними. Только просмотр — правка
   остаётся в разделах.

   Узлы стоят колонками слева направо — так, как одно следует из другого:
   приказ → пункт → правило → атрибут и подразделение. Узел — карточка с
   названием и второй строкой (название приказа, номер правила); тип узла
   назван заголовком колонки, цветная точка его только дублирует. Наведение
   или выбор узла подсвечивает всю его цепочку: откуда он и что из него следует.

   Трассировка проверки открывается с экрана проверки («Показать на графе»):
   цель появляется узлом справа, и от неё шаг за шагом проявляется путь —
   найденные атрибуты, сработавшие правила, их пункты и приказы. Роль узла
   в проверке показана цветом обводки и значком (✓ ✕). */

const KINDS: { kind: NodeKind; name: string; color: string; col: number; band: number }[] = [
  { kind: "Order", name: "Приказы", color: "#0c6ff1", col: 0, band: 0 },
  { kind: "Clause", name: "Пункты", color: "#eb6834", col: 1, band: 0 },
  { kind: "Rule", name: "Правила", color: "#1baf7a", col: 2, band: 0 },
  { kind: "CheckTarget", name: "Атрибуты", color: "#eda100", col: 3, band: 0 },
  { kind: "Department", name: "Подразделения", color: "#e87ba4", col: 3, band: 1 },
  { kind: "ViolationExample", name: "Примеры", color: "#4a3aa7", col: 3, band: 2 },
  { kind: "JobDescription", name: "Должностные инструкции", color: "#008300", col: 4, band: 0 },
];
const KIND = Object.fromEntries(KINDS.map((k) => [k.kind, k])) as Record<NodeKind, (typeof KINDS)[number]>;
const KIND_ONE: Record<NodeKind, string> = {
  Order: "Приказ", Clause: "Пункт", Rule: "Правило", CheckTarget: "Атрибут", Department: "Подразделение",
  JobDescription: "Должностная инструкция", ViolationExample: "Пример",
};
const EDGE_NAMES: Record<string, string> = {
  CONTAINS: "содержит", DEFINES: "задаёт", APPLIES_TO: "проверяет", HAS_EXAMPLE: "пример",
  REFERENCES: "ссылается на", ONLY_IN: "действует только в",
  HAS_JOB_DESCRIPTION: "инструкция",
};
/** Разделы каталога, куда можно перейти от узла. */
const OPENABLE: NodeKind[] = ["Order", "Clause", "Rule", "ViolationExample", "CheckTarget", "Department"];
/** Ширина карточек колонки: у правил текст длиннее всего; последняя колонка — цель проверки. */
const WIDTHS: Record<number, number> = { 0: 160, 1: 180, 2: 280, 3: 200, 4: 220, 5: 96 };
const NODE_H = 46;
const GOAL_COL = 5;
/** Поля вокруг схемы и место над ней под заголовки колонок, px схемы. */
const PAD = 32;
const HEAD = 36;

const GOAL = "__goal";
/** Роль узла или связи в проверке: найдено / нарушение / просто на пути. */
type Role = "ok" | "bad" | "path";
const ROLE_MARK: Record<Role, string> = { ok: "✓", bad: "✕", path: "" };
const WORST: Role[] = ["path", "ok", "bad"];
const worse = (a: Role | undefined, b: Role) => (!a || WORST.indexOf(b) > WORST.indexOf(a) ? b : a);
const edgeKey = (a: string, b: string) => (a < b ? `${a}>${b}` : `${b}>${a}`);

interface Trace {
  nodes: Map<string, Role>;
  edges: Map<string, Role>;
  /** Связи от узла цели: к найденным атрибутам, к ненайденным обязательным, к подразделению. */
  goalEdges: { target: string; role: Role; missing?: boolean }[];
  /** На каком шаге от цели путь доходит до узла — порядок появления в анимации. */
  steps: Map<string, number>;
}
/** Длительность одного шага анимации пути, с. */
const STEP_SECONDS = 0.45;

/** Путь проверки по графу: от цели через атрибуты к правилам, пунктам и приказам. */
function buildTrace(result: CheckResult, nodes: GraphNode[], edges: GraphEdge[]): Trace {
  const trace: Trace = { nodes: new Map([[GOAL, "path"]]), edges: new Map(), goalEdges: [], steps: new Map([[GOAL, 0]]) };
  const find = (label: NodeKind, title: string | null) =>
    nodes.find((n) => n.label === label && n.title === title && n.status !== "archived");
  const mark = (id: string, role: Role) => trace.nodes.set(id, worse(trace.nodes.get(id), role));
  const link = (a: string, b: string, role: Role) =>
    trace.edges.set(edgeKey(a, b), worse(trace.edges.get(edgeKey(a, b)), role));
  const toGoal = (target: string, role: Role, missing = false) => {
    if (!trace.goalEdges.some((e) => e.target === target)) trace.goalEdges.push({ target, role, missing });
  };
  const parent = (id: string, type: string) => edges.find((e) => e.type === type && e.target === id)?.source;

  for (const name of result.detected_attributes) {
    const target = find("CheckTarget", name);
    if (target) { mark(target.id, "ok"); toGoal(target.id, "ok"); }
  }
  const department = result.department
    && nodes.find((n) => n.label === "Department" && n.detail === result.department!.id);
  if (department) { mark(department.id, "path"); toGoal(department.id, "path"); }

  const follow = (row: { rule_id: string | null; rule_text: string | null; attribute: string;
    violation_type: string }, role: Role) => {
    // У правила, заведённого без ruleId, остаётся формулировка.
    const rule = (row.rule_id ? find("Rule", row.rule_id) : undefined)
      ?? nodes.find((n) => n.label === "Rule" && !!row.rule_text && n.detail === row.rule_text.slice(0, 300));
    const target = find("CheckTarget", row.attribute);
    if (target) {
      mark(target.id, role);
      // Требование нарушено тем, что атрибута в цели нет: связь «не найдено».
      if (row.violation_type === "MISSING_REQUIREMENT") toGoal(target.id, role, true);
    }
    if (!rule) return;
    mark(rule.id, role);
    if (target) link(rule.id, target.id, role);
    const clause = parent(rule.id, "DEFINES");
    if (!clause) return;
    mark(clause, role); link(clause, rule.id, role);
    const order = parent(clause, "CONTAINS");
    if (order) { mark(order, role); link(order, clause, role); }
  };
  result.violations.forEach((v) => follow(v, "bad"));

  // Обход в ширину от цели по связям пути: шаг узла — его расстояние от цели.
  const next = new Map<string, string[]>();
  const join = (a: string, b: string) => { next.set(a, [...(next.get(a) ?? []), b]); next.set(b, [...(next.get(b) ?? []), a]); };
  trace.goalEdges.forEach((e) => join(GOAL, e.target));
  for (const e of edges) if (trace.edges.has(edgeKey(e.source, e.target))) join(e.source, e.target);
  for (let queue = [GOAL]; queue.length;) {
    const id = queue.shift()!;
    for (const other of next.get(id) ?? [])
      if (!trace.steps.has(other)) { trace.steps.set(other, trace.steps.get(id)! + 1); queue.push(other); }
  }
  return trace;
}

type LoadState = { kind: "loading" } | { kind: "error"; message: string }
  | { kind: "ready"; nodes: GraphNode[]; edges: GraphEdge[] };
/** Сдвиг схемы в пикселях холста и масштаб. */
interface View { x: number; y: number; scale: number }

const short = (text: string, max = 22) => (text.length > max ? text.slice(0, max - 1) + "…" : text);
/** Сколько знаков влезает в строку карточки шириной w: Inter 13px — около 7px на знак. */
const clip = (text: string, w: number, px = 7) => short(text, Math.max(6, Math.floor((w - 40) / px)));

/** Правило на графе — без общего начала «Цель обязана содержать…»: иначе обрезанные подписи не различить. */
const ruleShort = (text: string) => {
  const rest = text.replace(/^цель(\s+студента)?\s+(обязана|должна)(\s+(содержать|иметь|называть|указывать))?\s+/i, "");
  return rest ? rest[0].toUpperCase() + rest.slice(1) : text;
};

/** Название узла для людей: правило — текстом, а не кодом; пункт — «п. 2.4»; атрибут — без подчёркиваний. */
const nameOf = (n: GraphNode) =>
  n.label === "Rule" && n.detail ? ruleShort(n.detail)
    : n.label === "Clause" ? `п. ${n.title}`
    : n.label === "CheckTarget" ? attributeTitle(n.title) : n.title;

/** Вторая строка карточки: название приказа, текст пункта, номер и вид правила. */
const subOf = (n: GraphNode) =>
  n.label === "Rule" ? [n.title, n.type === "PROHIBITION" ? "запрет" : n.type ? "требование" : ""].filter(Boolean).join(" · ")
    : n.label === "JobDescription" ? "" : n.detail;

/** Связь карточек — плавная кривая от краёв, обращённых друг к другу; внутри колонки — дуга справа. */
function curve(a: Box, b: Box): string {
  if (a.col === b.col) {
    const x = a.x + a.w;
    const bend = 28 + Math.min(80, Math.abs(b.y - a.y) * 0.2);
    return `M${x} ${a.y} C${x + bend} ${a.y} ${x + bend} ${b.y} ${x} ${b.y}`;
  }
  const forward = a.col < b.col;
  const x1 = forward ? a.x + a.w : a.x;
  const x2 = forward ? b.x : b.x + b.w;
  const mid = (x1 + x2) / 2;
  return `M${x1} ${a.y} C${mid} ${a.y} ${mid} ${b.y} ${x2} ${b.y}`;
}

/** Связи «вниз» по каталогу: приказ → пункт → правило → атрибут, подразделение, пример, инструкция. */
const DOWN = new Set(["CONTAINS", "DEFINES", "APPLIES_TO", "ONLY_IN", "HAS_EXAMPLE", "HAS_JOB_DESCRIPTION"]);

/** Цепочка узла: из чего он следует, что следует из него, и прямые соседи (ссылки между пунктами). */
function lineage(focus: string, edges: GraphEdge[]) {
  const down = new Map<string, GraphEdge[]>();
  const up = new Map<string, GraphEdge[]>();
  for (const e of edges) if (DOWN.has(e.type)) {
    down.set(e.source, [...(down.get(e.source) ?? []), e]);
    up.set(e.target, [...(up.get(e.target) ?? []), e]);
  }
  const ids = new Set([focus]);
  const keys = new Set<string>();
  const walk = (index: Map<string, GraphEdge[]>, end: (e: GraphEdge) => string) => {
    const seen = new Set([focus]);
    for (let queue = [focus]; queue.length;)
      for (const e of index.get(queue.shift()!) ?? []) {
        keys.add(edgeKey(e.source, e.target));
        const other = end(e);
        ids.add(other);
        if (!seen.has(other)) { seen.add(other); queue.push(other); }
      }
  };
  walk(up, (e) => e.source);
  walk(down, (e) => e.target);
  for (const e of edges) if (e.source === focus || e.target === focus) {
    keys.add(edgeKey(e.source, e.target)); ids.add(e.source); ids.add(e.target);
  }
  return { ids, keys };
}

export function GraphTab() {
  const { goToNode, trace: traced, setTrace } = useCatalog();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [off, setOff] = useState<Set<NodeKind>>(() => new Set<NodeKind>(["ViolationExample"]));
  const [archived, setArchived] = useState(false);
  // При трассировке по умолчанию виден только путь проверки: остальной каталог — по флажку.
  const [onlyPath, setOnlyPath] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  // Поиск узла по названию: Enter переходит к следующему найденному.
  const [query, setQuery] = useState("");
  const [hit, setHit] = useState(0);
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, scale: 1 });
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [boxSize, setBoxSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setBoxSize({ w: entry.contentRect.width, h: entry.contentRect.height }));
    observer.observe(el);
    return () => observer.disconnect();
  });

  const [busy, setBusy] = useState(false);
  // Номер обновления: с ним слой графа пересоздаётся, и анимация трассировки идёт заново.
  const [replay, setReplay] = useState(0);
  const load = useCallback(async () => {
    // Уже показанный граф остаётся на экране, пока читается новый: масштаб и сдвиг не теряются.
    setBusy(true);
    try {
      setState({ kind: "ready", ...(await api.graph()) });
      setReplay((n) => n + 1);
    } catch (err) {
      setState({ kind: "error", message: errorText(err) });
    } finally {
      setBusy(false);
    }
  }, []);
  // Каталог мог измениться в другом разделе — при каждом открытии читается заново.
  useEffect(() => { void load(); }, [load]);

  const trace = useMemo(
    () => (traced && state.kind === "ready" ? buildTrace(traced, state.nodes, state.edges) : null),
    [traced, state]);

  // Раскладка колонками линейна по числу узлов и связей, поэтому пересчитывается
  // на каждый фильтр: скрытые типы не оставляют пустых мест.
  const graph = useMemo(() => {
    if (state.kind !== "ready") return null;
    const visible = (n: GraphNode) => !off.has(n.label) && (archived || n.status !== "archived");
    // Узлы на пути проверки видны всегда, даже если их тип выключен.
    const nodes = state.nodes.filter((n) => trace?.nodes.has(n.id) || ((!trace || !onlyPath) && visible(n)));
    const shown = new Set(nodes.map((n) => n.id));
    const edges = state.edges.filter((e) => shown.has(e.source) && shown.has(e.target));
    const goalEdges = (trace?.goalEdges ?? []).filter((e) => shown.has(e.target));
    const layout = layoutColumns(
      [...nodes.map((n) => ({ id: n.id, col: KIND[n.label].col, band: KIND[n.label].band, key: n.title, h: NODE_H })),
        ...(trace ? [{ id: GOAL, col: GOAL_COL, band: 0, key: "", h: NODE_H }] : [])],
      [...edges.map((e): [string, string] => [e.source, e.target]),
        ...goalEdges.map((e): [string, string] => [GOAL, e.target])],
      WIDTHS);
    return { nodes, edges, goalEdges, layout, byId: new Map(nodes.map((n) => [n.id, n])) };
  }, [state, off, archived, trace, onlyPath]);

  /** Показать схему: целиком, если она так читается; иначе — по ширине, с начала. */
  const fitView = useCallback((whole: boolean) => {
    if (!graph || !boxSize.w) return;
    const width = graph.layout.width + PAD * 2;
    const height = graph.layout.height + HEAD + PAD * 2;
    const all = Math.min(1, boxSize.w / width, boxSize.h / height);
    const scale = whole || all >= 0.6 ? all : Math.min(1, boxSize.w / width);
    setView({
      scale,
      x: (boxSize.w - width * scale) / 2 + PAD * scale,
      y: height * scale <= boxSize.h ? (boxSize.h - height * scale) / 2 + (PAD + HEAD) * scale : (PAD + HEAD) * scale,
    });
  }, [graph, boxSize]);
  // Другой набор узлов — показать его заново. Обновление данных масштаб не трогает.
  const ready = !!graph && boxSize.w > 0;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (ready) fitView(false); }, [ready, traced, off, archived, onlyPath]);

  const zoomAt = (factor: number, cx: number, cy: number) => setView((v) => {
    const scale = Math.min(2.5, Math.max(0.15, v.scale * factor));
    const k = scale / v.scale;
    return { scale, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
  });
  const zoom = (factor: number) => zoomAt(factor, boxSize.w / 2, boxSize.h / 2);

  // Колесо прокручивает схему, с Ctrl (и щипок на тачпаде) — масштабирует под курсором.
  // Обработчик не пассивный: иначе вместе со схемой прокрутилась бы страница.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const rect = el.getBoundingClientRect();
        zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - rect.left, e.clientY - rect.top);
      } else setView((v) => ({ ...v, x: v.x - (e.shiftKey ? e.deltaY : e.deltaX), y: v.y - (e.shiftKey ? 0 : e.deltaY) }));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [ready]);

  const counts = useMemo(() => {
    const result = new Map<NodeKind, number>();
    if (state.kind === "ready")
      for (const n of state.nodes)
        if (archived || n.status !== "archived") result.set(n.label, (result.get(n.label) ?? 0) + 1);
    return result;
  }, [state, archived]);

  const focus = hover?.id ?? selected;
  const lit = useMemo(
    () => (graph && focus && graph.byId.has(focus) ? lineage(focus, graph.edges) : null), [graph, focus]);

  const toggle = (kind: NodeKind) => setOff((current) => {
    const next = new Set(current);
    if (!next.delete(kind)) next.add(kind);
    return next;
  });

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q && graph ? graph.nodes.filter((n) => [n.title, n.detail ?? "", nameOf(n)].some((t) => t.toLowerCase().includes(q))) : [];
  }, [query, graph]);
  /** Выделить найденный узел и поставить его в центр холста. */
  const jump = (index: number) => {
    if (!graph || !matches.length) return;
    const node = matches[index % matches.length];
    const b = graph.layout.boxes.get(node.id)!;
    setHit(index % matches.length);
    setSelected(node.id);
    setView((v) => {
      const scale = Math.max(v.scale, 0.9);
      return { scale, x: boxSize.w / 2 - (b.x + b.w / 2) * scale, y: boxSize.h / 2 - b.y * scale };
    });
  };

  /** Узел пути проявляется, когда до него дорисовалась линия. */
  const arrive = (id: string) => ({ animationDelay: `${(trace?.steps.get(id) ?? 0) * STEP_SECONDS}s` });

  const selectedNode = selected ? graph?.byId.get(selected) : undefined;
  const hoverNode = hover ? graph?.byId.get(hover.id) : undefined;
  const links = selectedNode && graph
    ? graph.edges.filter((e) => e.source === selectedNode.id || e.target === selectedNode.id) : [];

  // Узлы и связи не зависят от сдвига и масштаба: перетаскивание меняет только
  // transform группы, а не перерисовывает сотни узлов на каждое движение мыши.
  const layer = useMemo(() => {
    if (!graph) return null;
    const { boxes, columns, bands } = graph.layout;
    const dim = !!lit || !!trace;
    return (
      <>
        {bands.filter((b) => b.col !== GOAL_COL).map((b) => {
          const column = columns.find((c) => c.col === b.col)!;
          const kind = KINDS.find((k) => k.col === b.col && k.band === b.band)!;
          // Верхние заголовки — в одну линию над схемой, нижние полосы — над своим первым узлом.
          return (
            <text key={`${b.col}.${b.band}`} className="col-head" x={column.x + 2} y={b.band ? b.top - 14 : -HEAD + 10}>
              {kind.name} <tspan className="count">{b.count}</tspan>
            </text>
          );
        })}
        {graph.edges.map((e, i) => {
          const a = boxes.get(e.source)!;
          const b = boxes.get(e.target)!;
          const key = edgeKey(e.source, e.target);
          const role = trace?.edges.get(key);
          if (!role)
            return <path key={i} d={curve(a, b)}
              className={`edge ${e.type === "REFERENCES" ? "ref" : ""} ${lit?.keys.has(key) ? "lit" : dim ? "faded" : ""}`} />;
          // Линия пути рисуется от конца, ближнего к цели, — так путь «растёт» от неё.
          const sa = trace!.steps.get(e.source) ?? 0;
          const sb = trace!.steps.get(e.target) ?? 0;
          return <path key={i} d={sa <= sb ? curve(a, b) : curve(b, a)} pathLength={1}
            className={`edge trace ${role}`} style={{ animationDelay: `${Math.min(sa, sb) * STEP_SECONDS}s` }} />;
        })}
        {trace && graph.goalEdges.map((e) => (
          <path key={"goal" + e.target} d={curve(boxes.get(GOAL)!, boxes.get(e.target)!)} pathLength={1}
            className={`edge trace ${e.role} ${e.missing ? "missing" : ""}`} />
        ))}
        {graph.nodes.map((n) => {
          const b = boxes.get(n.id)!;
          const role = trace?.nodes.get(n.id);
          const on = lit?.ids.has(n.id);
          const sub = subOf(n);
          const pick = () => setSelected(n.id);
          return (
            <g key={n.id} transform={`translate(${b.x} ${b.y - b.h / 2})`} data-node={n.id}
              className={`node ${n.status === "archived" ? "archived" : ""} ${role ? `traced ${role}` : dim && !on ? "faded" : ""} ${on && lit ? "lit" : ""} ${selected === n.id ? "selected" : ""}`}
              role="button" tabIndex={0} aria-label={`${KIND_ONE[n.label]}: ${nameOf(n)}`}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={pick}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } }}
              onMouseEnter={(e) => {
                const rect = box.current!.getBoundingClientRect();
                setHover({ id: n.id, x: e.clientX - rect.left, y: e.clientY - rect.top });
              }}
              onMouseLeave={() => setHover(null)}>
              {role && role !== "path" && <rect className="halo" x={-4} y={-4} width={b.w + 8} height={b.h + 8} rx={14} style={arrive(n.id)} />}
              <rect className="face" width={b.w} height={b.h} rx={10} style={role ? arrive(n.id) : undefined} />
              <circle className="dot" cx={17} cy={b.h / 2} r={5} fill={KIND[n.label].color} />
              <text className="name" x={32} y={sub ? 19 : b.h / 2 + 4.5}>{clip(nameOf(n), b.w)}</text>
              {sub && <text className="sub" x={32} y={35}>{clip(sub, b.w, 6.2)}</text>}
              {role && ROLE_MARK[role] && (
                <g transform={`translate(${b.w - 2} 2)`} className="mark" style={arrive(n.id)}>
                  <circle r={9} /><text textAnchor="middle" y={4}>{ROLE_MARK[role]}</text>
                </g>
              )}
            </g>
          );
        })}
        {trace && (() => {
          const b = boxes.get(GOAL)!;
          return (
            <g transform={`translate(${b.x} ${b.y - b.h / 2})`} className="node goal" onMouseDown={(e) => e.stopPropagation()}
              onClick={() => setSelected(null)}>
              <rect width={b.w} height={b.h} rx={b.h / 2} />
              <text x={b.w / 2} y={b.h / 2 + 4.5} textAnchor="middle">Цель</text>
            </g>
          );
        })()}
      </>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, trace, lit, selected]);

  return (
    <section id="tab-graph">
      <PageHead title="Граф" sub="Каталог целиком: что из чего следует и где действует. Нажмите на узел, чтобы увидеть его цепочку.">
        {traced && <button className="btn" onClick={() => setTrace(null)}>Сбросить трассировку</button>}
        <button className="btn" disabled={busy} onClick={() => void load()}>
          {busy ? <><Spinner /> Обновляем…</> : "Обновить"}
        </button>
      </PageHead>
      <div className="toolbar graph-toolbar">
        <label className="graph-search">
          <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="9" cy="9" r="5.5" /><path d="M13.5 13.5L17 17" /></svg>
          <input type="search" aria-label="Найти узел" placeholder="Найти узел" value={query}
            onChange={(e) => { setQuery(e.target.value); setHit(0); }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); jump(matches.length && selected === matches[hit]?.id ? hit + 1 : hit); } }} />
          {query.trim() && <span className="dim">{matches.length ? `${hit + 1} из ${matches.length}` : "не найдено"}</span>}
        </label>
        {/* Кнопки типов — они же легенда. Типы, которых в каталоге нет, места не занимают. */}
        <div className="chips">
          {KINDS.filter((k) => (counts.get(k.kind) ?? 0) > 0).map((k) => (
            <button key={k.kind} className={`chip chip-btn legend ${off.has(k.kind) ? "off" : ""}`}
              aria-pressed={!off.has(k.kind)} disabled={!!trace && onlyPath} onClick={() => toggle(k.kind)}>
              <span className="swatch" style={{ background: k.color }} />{k.name}
              <span className="dim">{counts.get(k.kind) ?? 0}</span>
            </button>
          ))}
        </div>
        <div className="graph-flags">
          {trace && (
            <label className="check">
              <input type="checkbox" checked={onlyPath} onChange={(e) => setOnlyPath(e.target.checked)} /> Только путь проверки
            </label>
          )}
          <label className="check">
            <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Архив
          </label>
        </div>
      </div>

      {state.kind === "loading" && <Skeleton rows={5} />}
      {state.kind === "error" && <div className="card pad"><span className="badge warn">{state.message}</span></div>}
      {graph && !graph.nodes.length && <Empty icon="search" title="Показывать нечего">Каталог пуст или все типы узлов скрыты кнопками над графом.</Empty>}
      {graph && graph.nodes.length > 0 && (
        <div className="graph-page">
          <div className="card graph-box" ref={box}
            onMouseDown={(e) => { drag.current = { x: e.clientX, y: e.clientY, moved: false }; }}
            onMouseMove={(e) => {
              const d = drag.current;
              if (!d) return;
              if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3) d.moved = true;
              const dx = e.clientX - d.x;
              const dy = e.clientY - d.y;
              d.x = e.clientX; d.y = e.clientY;
              setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
            }}
            onMouseUp={() => { if (drag.current && !drag.current.moved) setSelected(null); drag.current = null; }}
            onMouseLeave={() => { drag.current = null; setHover(null); }}>
            <svg role="img" aria-label={`Граф каталога: узлов ${graph.nodes.length}, связей ${graph.edges.length}`}>
              <g key={replay} transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}
                className={`${trace ? "tracing" : ""} ${view.scale < 0.45 ? "far" : ""}`}>
                {layer}
              </g>
            </svg>
            <div className="graph-zoom">
              <button className="btn sm" aria-label="Отдалить" onClick={() => zoom(1 / 1.25)}>−</button>
              <span className="small dim">{Math.round(view.scale * 100)}%</span>
              <button className="btn sm" aria-label="Приблизить" onClick={() => zoom(1.25)}>+</button>
              <button className="btn sm" onClick={() => fitView(true)}>Весь граф</button>
            </div>
            <div className="graph-hint small dim">Перетаскивание и колесо — сдвиг · Ctrl + колесо — масштаб</div>
            {hoverNode && hover && (
              <div className="graph-tip" style={{ left: Math.min(hover.x + 14, boxSize.w - 300), top: hover.y + 14 }}>
                <div className="small dim">{KIND_ONE[hoverNode.label]}{hoverNode.label === "Rule" ? ` · ${hoverNode.title}` : ""}</div>
                <div className="mid">{nameOf(hoverNode)}</div>
                {hoverNode.detail && hoverNode.label !== "Rule" && <div className="small muted">{short(hoverNode.detail, 160)}</div>}
              </div>
            )}
          </div>

          <aside className="graph-side card pad">
            {selectedNode ? (
              <>
                <div className="row node-kind">
                  <span className="swatch" style={{ background: KIND[selectedNode.label].color }} />
                  <span>{KIND_ONE[selectedNode.label]}</span>
                  {selectedNode.status === "archived" && <span className="badge archived">в архиве</span>}
                  {selectedNode.type && (
                    <span className="badge">{selectedNode.type === "PROHIBITION" ? "запрет" : "требование"}</span>
                  )}
                </div>
                <h2 className="node-title">{nameOf(selectedNode)}</h2>
                {selectedNode.label === "Rule" && <div className="dim">{selectedNode.title}</div>}
                {selectedNode.detail && selectedNode.label !== "Rule" && <p className="muted node-detail">{selectedNode.detail}</p>}
                {OPENABLE.includes(selectedNode.label) && (
                  <button className="btn sm primary" style={{ marginTop: 12 }}
                    onClick={() => void goToNode(selectedNode.id, selectedNode.label)}>
                    Открыть {KIND_ONE[selectedNode.label].toLowerCase()}
                  </button>
                )}
                <div className="node-kind" style={{ marginTop: 18 }}>Связи: {links.length}</div>
                {links.map((e, i) => {
                  const out = e.source === selectedNode.id;
                  const other = graph.byId.get(out ? e.target : e.source)!;
                  return (
                    <button key={i} className="graph-link node-link" onClick={() => setSelected(other.id)}
                      title={EDGE_NAMES[e.type] ?? e.type}>
                      <span className="swatch" style={{ background: KIND[other.label].color }} />
                      {/* Тип соседа, а у области действия — сама связь: «действует только в АГД». */}
                      <span className="dim">{e.type === "ONLY_IN" && out ? EDGE_NAMES.ONLY_IN : KIND_ONE[other.label]}</span>
                      <span>{nameOf(other)}</span>
                    </button>
                  );
                })}
              </>
            ) : traced && trace ? (
              <TraceSummary result={traced}
                onPick={(label, title, detail) => {
                  const found = graph.nodes.find((n) => n.label === label && n.title === title)
                    ?? graph.nodes.find((n) => n.label === label && !!detail && n.detail === detail.slice(0, 300));
                  if (found) setSelected(found.id);
                }} />
            ) : (
              <>
                <h3>Узлов: {graph.nodes.length} · связей: {graph.edges.length}</h3>
                <p className="muted" style={{ marginTop: 8 }}>
                  Схема читается слева направо: приказ содержит пункты, пункт задаёт правила, правило проверяет
                  атрибуты цели и может действовать только в отдельных подразделениях.
                </p>
                <p className="muted" style={{ marginTop: 8 }}>
                  Выберите узел, чтобы подсветить его цепочку и увидеть связи, или найдите его по названию.
                </p>
              </>
            )}
          </aside>
        </div>
      )}
    </section>
  );
}

/* Итог проверки рядом с графом: что найдено в цели и какие правила сработали.
   Строки ведут к узлам на графе. */
function TraceSummary({ result, onPick }: {
  result: CheckResult; onPick: (label: NodeKind, title: string | null, detail?: string | null) => void;
}) {
  const manual = result.status === "NEEDS_MANUAL_REVIEW";
  const bad = result.violations.length;
  return (
    <>
      <div className="row wrap" style={{ gap: 8 }}>
        {manual ? <span className="badge warn">Требуется ручная проверка</span>
          : bad ? <span className="badge err">Нужно доработать</span> : <span className="badge ok">Нарушений нет</span>}
        <span className="small dim">{result.department ? result.department.name || result.department.id : "подразделение не определено"}</span>
      </div>
      <p className="muted" style={{ margin: "10px 0" }}>«{result.goal}»</p>
      <div className="trace-legend small">
        <span><i className="ok">✓</i> найдено в цели</span>
        <span><i className="bad">✕</i> нарушение</span>
      </div>
      {result.detected_attributes.length > 0 && <h3 style={{ margin: "14px 0 0" }}>Найдено в цели</h3>}
      {result.detected_attributes.map((name) => (
        <button key={name} className="graph-link" onClick={() => onPick("CheckTarget", name)}>
          <span><i className="trace-mark ok">✓</i> {attributeTitle(name)}</span>
        </button>
      ))}
      {bad > 0 && <h3 style={{ margin: "14px 0 0" }}>Нарушения: {bad}</h3>}
      {result.violations.map((v, i) => (
        <button key={"v" + i} className="graph-link" onClick={() => onPick("Rule", v.rule_id, v.rule_text)}>
          <span className="small dim">Приказ {v.order_number ?? "?"}, пункт {v.clause_code ?? "?"} · {v.rule_id}</span>
          <span><i className="trace-mark bad">✕</i> {v.rule_text}</span>
          <span className="small dim">
            {v.violation_type === "MISSING_REQUIREMENT" ? "в цели нет: " : "в цели есть: "}{v.attribute}
          </span>
        </button>
      ))}
      {result.notes.map((n, i) => <div key={"n" + i} className="alert small" style={{ marginTop: 8 }}>{n}</div>)}
    </>
  );
}
