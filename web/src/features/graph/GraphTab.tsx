import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api } from "../../api/client";
import type { CheckResult, GraphEdge, GraphNode, NodeKind } from "../../api/types";
import { useCatalog } from "../../state/catalog";
import { attributeTitle, Empty, PageHead, Skeleton, Spinner } from "../../ui/common";
import { errorText } from "../../ui/Toasts";
import { layoutGraph } from "./layout";

/* Каталог как граф: приказы, пункты, правила, атрибуты, подразделения и
   должностные инструкции со связями между ними. Только просмотр — правка
   остаётся в разделах. Цвет узла — его тип; тип продублирован в легенде и
   в карточке узла, так что цвет не единственный признак.

   Трассировка проверки открывается с экрана проверки («Показать на графе»):
   цель появляется узлом, и от неё шаг за шагом проявляется путь — найденные
   атрибуты, сработавшие правила, их пункты и приказы. Роль узла в проверке
   показана цветом обводки и значком (✓ ✕ –). */

const KINDS: { kind: NodeKind; name: string; color: string; r: number }[] = [
  { kind: "Order", name: "Приказы", color: "#0c6ff1", r: 11 },
  { kind: "Clause", name: "Пункты", color: "#eb6834", r: 8 },
  { kind: "Rule", name: "Правила", color: "#1baf7a", r: 8 },
  { kind: "CheckTarget", name: "Атрибуты", color: "#eda100", r: 8 },
  { kind: "Department", name: "Подразделения", color: "#e87ba4", r: 10 },
  { kind: "JobDescription", name: "Должностные инструкции", color: "#008300", r: 7 },
  { kind: "ViolationExample", name: "Примеры", color: "#4a3aa7", r: 6 },
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
const LABELS_ALWAYS = 120;   // при большем числе узлов подписи — только у крупных и выделенных

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
interface View { x: number; y: number; scale: number }

const short = (text: string, max = 22) => (text.length > max ? text.slice(0, max - 1) + "…" : text);

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

export function GraphTab() {
  const { goToNode, trace: traced, setTrace } = useCatalog();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [off, setOff] = useState<Set<NodeKind>>(() => new Set<NodeKind>(["ViolationExample"]));
  const [archived, setArchived] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  // Поиск узла по названию: Enter переходит к следующему найденному.
  const [query, setQuery] = useState("");
  const [hit, setHit] = useState(0);
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, scale: 1 });
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  // Размер холста: от него зависит, во сколько раз вписанный граф уменьшен, а значит — размер подписей.
  const [boxSize, setBoxSize] = useState({ w: 800, h: 560 });
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

  // Раскладка — один раз на весь граф (со всеми типами и архивом): кнопки типов и флажок
  // «Архив» только скрывают узлы, а не пересчитывают O(n²) раскладку на основном потоке.
  const layout = useMemo(() => (state.kind !== "ready" ? null : layoutGraph(
    [...state.nodes.map((n) => n.id), ...(trace ? [GOAL] : [])],
    [...state.edges.map((e): [string, string] => [e.source, e.target]),
      ...(trace?.goalEdges ?? []).map((e): [string, string] => [GOAL, e.target])])), [state, trace]);

  const graph = useMemo(() => {
    if (state.kind !== "ready" || !layout) return null;
    // Узлы на пути проверки видны всегда, даже если их тип выключен.
    const nodes = state.nodes.filter((n) => trace?.nodes.has(n.id)
      || (!off.has(n.label) && (archived || n.status !== "archived")));
    const shown = new Set(nodes.map((n) => n.id));
    const edges = state.edges.filter((e) => shown.has(e.source) && shown.has(e.target));
    const goalEdges = (trace?.goalEdges ?? []).filter((e) => shown.has(e.target));
    const positions = layout;
    // Рамка — по видимым узлам: скрытые не оставляют пустых полей по краям.
    const points = [...nodes.map((n) => layout.get(n.id)!), ...(trace ? [layout.get(GOAL)!] : [])];
    const pad = 80;
    const minX = Math.min(...points.map((p) => p.x), 0) - pad;
    const minY = Math.min(...points.map((p) => p.y), 0) - pad;
    // Справа запас больше: подписи узлов стоят правее точки.
    const width = Math.max(...points.map((p) => p.x), 0) + pad + 90 - minX;
    const height = Math.max(...points.map((p) => p.y), 0) + pad - minY;
    // Вписанный в холст граф уменьшен: точки и подписи растут обратно, чтобы на экране
    // подпись оставалась около 13px, а точка — заметной.
    const fit = Math.min(boxSize.w / width, boxSize.h / height);
    const k = Math.min(4, Math.max(1, 1 / fit));
    return { nodes, edges, goalEdges, positions, k, viewBox: { minX, minY, width, height }, byId: new Map(nodes.map((n) => [n.id, n])) };
  }, [state, layout, off, archived, trace, boxSize]);

  // Новая трассировка — показать граф целиком. Обновление данных масштаб не трогает.
  useEffect(() => { setView({ x: 0, y: 0, scale: 1 }); }, [traced]);

  const counts = useMemo(() => {
    const result = new Map<NodeKind, number>();
    if (state.kind === "ready")
      for (const n of state.nodes)
        if (archived || n.status !== "archived") result.set(n.label, (result.get(n.label) ?? 0) + 1);
    return result;
  }, [state, archived]);

  const neighbours = useMemo(() => {
    const focus = hover?.id ?? selected;
    if (!graph || !focus) return null;
    const ids = new Set([focus]);
    for (const e of graph.edges) {
      if (e.source === focus) ids.add(e.target);
      if (e.target === focus) ids.add(e.source);
    }
    return ids;
  }, [graph, hover, selected]);

  const toggle = (kind: NodeKind) => setOff((current) => {
    const next = new Set(current);
    if (!next.delete(kind)) next.add(kind);
    return next;
  });

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q && graph ? graph.nodes.filter((n) => [n.title, n.detail ?? "", nameOf(n)].some((t) => t.toLowerCase().includes(q))) : [];
  }, [query, graph]);
  /** Выделить найденный узел и поставить его в центр холста, приблизив. */
  const jump = (index: number) => {
    if (!graph || !matches.length) return;
    const node = matches[index % matches.length];
    const p = graph.positions.get(node.id)!;
    const { minX, minY, width, height } = graph.viewBox;
    setHit(index % matches.length);
    setSelected(node.id);
    setView((v) => {
      const scale = Math.max(v.scale, 1.6);
      return { scale, x: minX + width / 2 - p.x * scale, y: minY + height / 2 - p.y * scale };
    });
  };

  const zoom = (factor: number) => setView((v) => ({ ...v, scale: Math.min(6, Math.max(0.4, v.scale * factor)) }));

  /** Узел пути проявляется, когда до него дорисовалась линия. */
  const arrive = (id: string) => ({ animationDelay: `${(trace?.steps.get(id) ?? 0) * STEP_SECONDS}s` });

  const selectedNode = selected ? graph?.byId.get(selected) : undefined;
  const hoverNode = hover ? graph?.byId.get(hover.id) : undefined;
  const links = selectedNode && graph
    ? graph.edges.filter((e) => e.source === selectedNode.id || e.target === selectedNode.id) : [];

  // Узлы и связи не зависят от сдвига и масштаба: перетаскивание графа меняет только
  // transform группы, а не перерисовывает сотни узлов на каждое движение мыши.
  const focus = hover?.id ?? selected;
  const layer = useMemo(() => graph && (
    <>
      {graph.edges.map((e, i) => {
        const a = graph.positions.get(e.source)!;
        const b = graph.positions.get(e.target)!;
        const role = trace?.edges.get(edgeKey(e.source, e.target));
        const lit = neighbours && (e.source === focus || e.target === focus);
        if (!role)
          return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y}
            className={`edge ${lit ? "lit" : neighbours || trace ? "faded" : ""}`} />;
        // Линия пути рисуется от конца, ближнего к цели, — так путь «растёт» от неё.
        const sa = trace!.steps.get(e.source) ?? 0;
        const sb = trace!.steps.get(e.target) ?? 0;
        const [from, to] = sa <= sb ? [a, b] : [b, a];
        return <line key={i} x1={from.x} y1={from.y} x2={to.x} y2={to.y} pathLength={1}
          className={`edge trace ${role}`} style={{ animationDelay: `${Math.min(sa, sb) * STEP_SECONDS}s` }} />;
      })}
      {trace && graph.goalEdges.map((e) => {
        const a = graph.positions.get(GOAL)!;
        const b = graph.positions.get(e.target)!;
        return <line key={"goal" + e.target} x1={a.x} y1={a.y} x2={b.x} y2={b.y} pathLength={1}
          className={`edge trace ${e.role} ${e.missing ? "missing" : ""}`} />;
      })}
      {graph.nodes.map((n) => {
        const p = graph.positions.get(n.id)!;
        const kind = KIND[n.label];
        const lit = neighbours?.has(n.id);
        const role = trace?.nodes.get(n.id);
        const label = graph.nodes.length <= LABELS_ALWAYS || lit || role || n.label === "Order" || n.label === "Department";
        return (
          <g key={n.id} transform={`translate(${p.x} ${p.y})`} data-node={n.id}
            className={`node ${n.status === "archived" ? "archived" : ""} ${role ? `traced ${role}` : (neighbours && !lit) || (trace && !lit) ? "faded" : ""} ${selected === n.id ? "selected" : ""}`}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => setSelected(n.id)}
            onMouseEnter={(e) => {
              const rect = box.current!.getBoundingClientRect();
              setHover({ id: n.id, x: e.clientX - rect.left, y: e.clientY - rect.top });
            }}
            onMouseLeave={() => setHover(null)}>
            <circle r={(kind.r + 6) * graph.k} className="hit" />
            {role && role !== "path" && <circle r={(kind.r + 5) * graph.k} className="halo" style={arrive(n.id)} />}
            <circle r={kind.r * graph.k} fill={kind.color} className="dot" style={role ? arrive(n.id) : undefined} />
            {role && ROLE_MARK[role] && (
              <g transform={`translate(${kind.r * graph.k} ${-kind.r * graph.k}) scale(${graph.k})`} className="mark" style={arrive(n.id)}>
                <circle r={6.5} /><text textAnchor="middle" y={3.5}>{ROLE_MARK[role]}</text>
              </g>
            )}
            {label && <text textAnchor="middle" y={(kind.r + 15) * graph.k} style={{ fontSize: 13 * graph.k }}>{short(nameOf(n), 26)}</text>}
          </g>
        );
      })}
      {trace && (() => {
        const p = graph.positions.get(GOAL)!;
        return (
          <g transform={`translate(${p.x} ${p.y}) scale(${graph.k})`} className="node goal" onMouseDown={(e) => e.stopPropagation()}
            onClick={() => setSelected(null)}>
            <rect x={-30} y={-13} width={60} height={26} rx={13} />
            <text textAnchor="middle" y={4}>Цель</text>
          </g>
        );
      })()}
    </>
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [graph, trace, neighbours, focus, selected]);

  return (
    <section id="tab-graph">
      <PageHead title="Граф" sub="Каталог целиком: что из чего следует и где действует. Нажмите на узел, чтобы увидеть его связи.">
        {traced && <button className="btn" onClick={() => setTrace(null)}>Сбросить трассировку</button>}
        <button className="btn" disabled={busy} onClick={() => void load()}>
          {busy ? <><Spinner /> Обновляем…</> : "Обновить"}
        </button>
      </PageHead>
      <div className="toolbar">
        <label className="graph-search">
          <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="9" cy="9" r="5.5" /><path d="M13.5 13.5L17 17" /></svg>
          <input type="search" aria-label="Найти узел" placeholder="Найти узел" value={query}
            onChange={(e) => { setQuery(e.target.value); setHit(0); }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); jump(matches.length && selected === matches[hit]?.id ? hit + 1 : hit); } }} />
          {query.trim() && <span className="dim">{matches.length ? `${hit + 1} из ${matches.length}` : "не найдено"}</span>}
        </label>
        {/* Типы, которых в каталоге нет, не занимают место в панели. */}
        {KINDS.filter((k) => (counts.get(k.kind) ?? 0) > 0).map((k) => (
          <button key={k.kind} className={`chip chip-btn legend ${off.has(k.kind) ? "off" : ""}`}
            aria-pressed={!off.has(k.kind)} onClick={() => toggle(k.kind)}>
            <span className="swatch" style={{ background: k.color }} />{k.name}
            <span className="dim">{counts.get(k.kind) ?? 0}</span>
          </button>
        ))}
        <label className="check">
          <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Архив
        </label>
      </div>

      {state.kind === "loading" && <Skeleton rows={5} />}
      {state.kind === "error" && <div className="card pad"><span className="badge warn">{state.message}</span></div>}
      {graph && !graph.nodes.length && <Empty icon="search" title="Показывать нечего">Каталог пуст или все типы узлов скрыты кнопками над графом.</Empty>}
      {graph && graph.nodes.length > 0 && (
        <div className="graph-page">
          <div className="card graph-box" ref={box}
            onWheel={(e) => zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15)}
            onMouseDown={(e) => { drag.current = { x: e.clientX, y: e.clientY, moved: false }; }}
            onMouseMove={(e) => {
              const d = drag.current;
              if (!d) return;
              const rect = box.current!.getBoundingClientRect();
              // Сдвиг в единицах viewBox: экранные пиксели делятся на масштаб вписывания.
              const fit = Math.min(rect.width / graph.viewBox.width, rect.height / graph.viewBox.height);
              const dx = (e.clientX - d.x) / fit;
              const dy = (e.clientY - d.y) / fit;
              if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3) d.moved = true;
              d.x = e.clientX; d.y = e.clientY;
              setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
            }}
            onMouseUp={() => { if (drag.current && !drag.current.moved) setSelected(null); drag.current = null; }}
            onMouseLeave={() => { drag.current = null; setHover(null); }}>
            <svg role="img" aria-label={`Граф каталога: узлов ${graph.nodes.length}, связей ${graph.edges.length}`}
              viewBox={`${graph.viewBox.minX} ${graph.viewBox.minY} ${graph.viewBox.width} ${graph.viewBox.height}`}>
              <g key={replay} transform={`translate(${view.x} ${view.y}) scale(${view.scale})`} className={trace ? "tracing" : ""}>
                {layer}
              </g>
            </svg>
            <div className="graph-zoom">
              <button className="btn sm" aria-label="Приблизить" onClick={() => zoom(1.3)}>+</button>
              <button className="btn sm" aria-label="Отдалить" onClick={() => zoom(1 / 1.3)}>−</button>
              <button className="btn sm" onClick={() => setView({ x: 0, y: 0, scale: 1 })}>Весь граф</button>
            </div>
            {hoverNode && hover && (
              <div className="graph-tip" style={{ left: hover.x + 14, top: hover.y + 14 }}>
                <div className="small dim">{KIND_ONE[hoverNode.label]}</div>
                <div className="mid">{nameOf(hoverNode)}</div>
                {hoverNode.detail && <div className="small muted">{short(hoverNode.detail, 140)}</div>}
              </div>
            )}
          </div>

          <aside className="graph-side">
            <div className="card pad">
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
                <div className="node-kind" style={{ marginTop: 12 }}>Связи: {links.length}</div>
                {links.map((e, i) => {
                  const out = e.source === selectedNode.id;
                  const other = graph.byId.get(out ? e.target : e.source)!;
                  return (
                    <button key={i} className="graph-link" onClick={() => setSelected(other.id)}
                      title={EDGE_NAMES[e.type] ?? e.type}>
                      {/* Тип соседа, а у области действия — сама связь: «действует только в АГД». */}
                      <span className="dim">{e.type === "ONLY_IN" && out ? EDGE_NAMES.ONLY_IN : KIND_ONE[other.label]}</span>
                      <span>{nameOf(other)}</span>
                    </button>
                  );
                })}
                {OPENABLE.includes(selectedNode.label) && (
                  <button className="btn sm primary" style={{ marginTop: 12 }}
                    onClick={() => void goToNode(selectedNode.id, selectedNode.label)}>
                    Открыть {KIND_ONE[selectedNode.label].toLowerCase()}
                  </button>
                )}
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
                <p className="muted" style={{ marginTop: 8 }}>Выберите узел на графе или найдите его по названию.</p>
              </>
            )}
            </div>
            <div className="card pad">
              <h3>Легенда</h3>
              <div className="graph-legend">
                {KINDS.filter((k) => !off.has(k.kind)).map((k) => (
                  <span key={k.kind}><span className="swatch" style={{ background: k.color }} />{KIND_ONE[k.kind]}</span>
                ))}
              </div>
              <p className="small dim" style={{ marginTop: 10 }}>
                Колесо мыши — масштаб, перетаскивание — сдвиг. Наведите на узел, чтобы подсветить его связи.
              </p>
            </div>
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
          <span><i className="trace-mark ok">✓</i> {name}</span>
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
