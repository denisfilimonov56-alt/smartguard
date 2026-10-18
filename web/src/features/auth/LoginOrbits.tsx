import { useEffect, useState } from "react";

import logo from "../../assets/logo.png";

/* Граф-орбиты на экране входа: эмблема в центре, вокруг на пунктирных
   кольцах — виды сущностей каталога (приказы, пункты, правила, атрибуты,
   подразделения, цели), соединённые спицами с центром и цепочкой по кругу.
   Раз в несколько секунд по цепочке проходит проверка очередной цели:
   от цели к атрибутам (найденные — с галочкой, недостающие — пунктиром
   с крестом), дальше к сработавшим правилам, их пункту и приказу. Узлы неподвижны, поэтому прорисовка линий и
   появление ярлыков — обычные CSS-анимации с задержкой по шагам.
   Кольца медленно «вращаются» сдвигом пунктира (stroke-dashoffset), без
   CSS-transform: в Safari поворот круга вокруг его центра съезжал. Данные вымышленные, к API не обращается.
   При prefers-reduced-motion всё стоит на месте и показана первая проверка
   целиком. */

type Role = "path" | "ok" | "bad";
interface Scene {
  goal: string;
  /** Атрибуты цели: найденные (ok) и обязательные, которых не хватает (bad). */
  attrs: [string, Role][];
  rules: [string, Role][];
  clause: string;
  order: string;
}

/** Координаты — в viewBox 760 × 320, центр — эмблема. */
const C = { x: 380, y: 160 };
const RINGS = [110, 180, 250];
interface Node { id: string; name: string; r: number; x: number; y: number; /** Подпись слева от узла. */ left: boolean; /** Сдвиг подписи по вертикали: над линией цепочки у верхних узлов, под узлом у нижних. */ dy?: number; /** Подпись по центру под узлом. */ mid?: boolean }
const NODES: Node[] = [
  { id: "clause", name: "Пункты", r: 7, x: 252, y: 34, left: false, dy: -12 },
  { id: "rule", name: "Правила", r: 7, x: 508, y: 34, left: true, dy: -12 },
  { id: "order", name: "Приказы", r: 9, x: 135, y: 212, left: false },
  { id: "attr", name: "Атрибуты", r: 7, x: 604, y: 262, left: true },
  { id: "dept", name: "Подразделения", r: 7, x: 296, y: 242, left: true, dy: 22 },
  { id: "goal", name: "Цели", r: 8, x: 462, y: 268, left: false, dy: 22 },
];
const BY_ID = Object.fromEntries(NODES.map((n) => [n.id, n])) as Record<string, Node>;
/** Цепочка по кругу: цель → атрибуты → правила → пункты → приказы → подразделения. */
const CHAIN = ["goal", "attr", "rule", "clause", "order", "dept"];

const SCENES: Scene[] = [
  { goal: "В рамках проекта «Альфа» разработать API для интеграции до 01.06.2025",
    attrs: [["проект", "ok"], ["срок", "ok"]], rules: [["Указан проект", "ok"], ["Есть срок", "ok"]],
    clause: "п. 2.4", order: "ПР-01" },
  { goal: "Пройти курс по работе в Excel",
    attrs: [["обучение", "ok"]], rules: [["Не обучение", "bad"]],
    clause: "п. 3.1", order: "ПР-02" },
  { goal: "Внедрить мониторинг в проекте «Бета» — снизить время реакции вдвое",
    attrs: [["проект", "ok"], ["результат", "ok"], ["срок", "bad"]], rules: [["Указан проект", "ok"], ["Есть срок", "bad"]],
    clause: "п. 2.4", order: "ПР-01" },
];
/** Сколько держится одна проверка, мс; шаги трассировки — задержки в секундах. */
export const SCENE_MS = 8000;
const T = { goal: 0, edge1: 0.3, attr: 0.9, edge2: 1.6, rule: 2.2, edge3: 2.9, clause: 3.5, edge4: 4.1, order: 4.7 };
const STILL = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

const worst = (roles: Role[]): Role => (roles.includes("bad") ? "bad" : roles.includes("ok") ? "ok" : "path");
const delay = (s: number) => ({ animationDelay: `${s}s` });
/** Ширина ярлыка по длине текста: шрифт 11px, плюс место под отметку. */
const chipWidth = (text: string, mark: boolean) => Math.round(text.length * 6.6) + (mark ? 34 : 18);

function Chip({ node, index, count, text, role, at }: { node: Node; index: number; count: number; text: string; role: Role; at: number }) {
  const mark = role !== "path";
  const w = chipWidth(text, mark);
  const dir = node.x < C.x ? -1 : 1;   // ярлыки уходят наружу от центра
  const x = node.x + dir * (node.r + 10);
  const y = node.y + (index - (count - 1) / 2) * 26;
  // Координаты — на внешней группе, анимация появления (transform) — на внутренней:
  // в Safari CSS-анимация transform затирает атрибут transform того же элемента.
  return (
    <g transform={`translate(${x} ${y})`}>
      <g className={`chip ${role}`} style={delay(at)}>
        <rect x={dir < 0 ? -w : 0} y={-11} width={w} height={22} rx={11} />
        {mark && <g transform={`translate(${dir * 13} 0)`} className="mark"><circle r={7} /><text textAnchor="middle" y={3.2}>{role === "ok" ? "✓" : "✕"}</text></g>}
        <text x={dir * (mark ? 25 : 9)} y={4} textAnchor={dir < 0 ? "end" : "start"}>{text}</text>
      </g>
    </g>
  );
}

export function LoginOrbits() {
  const [scene, setScene] = useState(0);
  useEffect(() => {
    if (STILL) return;
    const timer = setInterval(() => setScene((s) => (s + 1) % SCENES.length), SCENE_MS);
    return () => clearInterval(timer);
  }, []);

  const cur = SCENES[scene];
  const attrRole = worst(cur.attrs.map(([, r]) => r));
  const ruleRole = worst(cur.rules.map(([, r]) => r));
  /** Роль и задержка каждого звена цепочки и каждого узла в текущей проверке. */
  const edges: Record<string, { role: Role; at: number }> = {
    goal: { role: "path", at: T.edge1 }, attr: { role: attrRole, at: T.edge2 },
    rule: { role: ruleRole, at: T.edge3 }, clause: { role: ruleRole, at: T.edge4 },
  };
  const halos: Record<string, { role: Role; at: number }> = {
    goal: { role: "path", at: T.goal }, attr: { role: attrRole, at: T.attr }, rule: { role: ruleRole, at: T.rule },
    clause: { role: "path", at: T.clause }, order: { role: "path", at: T.order },
  };
  const line = (key: string, a: { x: number; y: number }, b: Node, props: React.SVGProps<SVGLineElement>) =>
    <line key={key} x1={a.x} y1={a.y} x2={b.x} y2={b.y} {...props} />;

  return (
    <div className="login-orbits" aria-hidden="true">
      <svg className="orbit" viewBox="0 0 760 320">
        {RINGS.map((r, i) => (
          <circle key={r} className="ring" cx={C.x} cy={C.y} r={r}
            style={{ animationDuration: `${2 + i * 0.6}s`, animationDirection: i % 2 ? "reverse" : "normal" }} />
        ))}
        <g className="base">
          {NODES.map((n) => line(n.id, C, n, { className: "spoke" }))}
          {CHAIN.slice(1).map((id, i) => line(id, BY_ID[CHAIN[i]], BY_ID[id], { className: "link" }))}
        </g>
        {/* Эмблема — внутри SVG, чтобы всегда стоять в центре колец при любом размере. */}
        <g className="hub" transform={`translate(${C.x} ${C.y})`}>
          <circle r={68} className="hub-glow" />
          <circle r={56} className="hub-disc" />
          <image href={logo} x={-32} y={-32} width={64} height={64} />
        </g>
        <g className="scene" key={scene} style={{ animationDuration: `${SCENE_MS}ms` }}>
          {Object.entries(edges).map(([from, e], i) =>
            line(from, BY_ID[from], BY_ID[CHAIN[i + 1]], { pathLength: 1, className: `edge trace ${e.role}`, style: delay(e.at) }))}
          <circle className="halo path hub" cx={C.x} cy={C.y} r={76} style={delay(T.goal)} />
          {NODES.map((n) => halos[n.id] && (
            <circle key={n.id} className={`halo ${halos[n.id].role}`} cx={n.x} cy={n.y} r={n.r + 6} style={delay(halos[n.id].at)} />
          ))}
          {cur.attrs.map(([text, role], i) => <Chip key={text} node={BY_ID.attr} index={i} count={cur.attrs.length} text={text} role={role} at={T.attr + i * 0.15} />)}
          {cur.rules.map(([text, role], i) => <Chip key={text} node={BY_ID.rule} index={i} count={cur.rules.length} text={text} role={role} at={T.rule + i * 0.15} />)}
          <Chip node={BY_ID.clause} index={0} count={1} text={cur.clause} role="path" at={T.clause} />
          <Chip node={BY_ID.order} index={0} count={1} text={cur.order} role="path" at={T.order} />
        </g>
        {NODES.map((n) => (
          <g key={n.id} className={`node ${n.id}`} transform={`translate(${n.x} ${n.y})`}>
            <circle r={n.r} className="dot" />
            <text x={n.mid ? 0 : (n.r + 8) * (n.left ? -1 : 1)} y={n.dy ?? 4} textAnchor={n.mid ? "middle" : n.left ? "end" : "start"}>{n.name}</text>
          </g>
        ))}
      </svg>
      <div className="login-scene" key={scene} style={{ animationDuration: `${SCENE_MS}ms` }}>«{cur.goal}»</div>
    </div>
  );
}
