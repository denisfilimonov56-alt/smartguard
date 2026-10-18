/* Раскладка графа силами (Фрюхтерман — Рейнгольд): узлы отталкиваются,
   связи стягивают. Считается один раз на набор узлов, без анимации.
   Сторонней библиотеки нет намеренно: сервер без интернета, а граф каталога
   невелик — сотни узлов. */

export interface Point { x: number; y: number }

export function layoutGraph(ids: string[], edges: [string, string][], iterations = 300): Map<string, Point> {
  const n = ids.length;
  const k = 70;                                   // желаемая длина связи
  const size = Math.max(300, Math.sqrt(n) * k * 1.6);
  const index = new Map(ids.map((id, i) => [id, i]));
  // Начальное положение — по спирали: детерминированно и без совпадающих точек.
  const x = ids.map((_, i) => Math.cos(i * 2.4) * Math.sqrt(i + 1) * k * 0.45);
  const y = ids.map((_, i) => Math.sin(i * 2.4) * Math.sqrt(i + 1) * k * 0.45);
  const links = edges.map(([a, b]) => [index.get(a), index.get(b)] as const)
    .filter((l): l is readonly [number, number] => l[0] !== undefined && l[1] !== undefined && l[0] !== l[1]);

  for (let step = 0; step < iterations; step++) {
    const dx = new Float64Array(n);
    const dy = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const vx = x[i] - x[j] || 0.01;
        const vy = y[i] - y[j] || 0.01;
        const d2 = vx * vx + vy * vy;
        const f = (k * k) / d2;                   // сила / расстояние
        dx[i] += vx * f; dy[i] += vy * f;
        dx[j] -= vx * f; dy[j] -= vy * f;
      }
      // Слабое притяжение к центру: несвязанные части не разлетаются.
      dx[i] -= x[i] * 0.25; dy[i] -= y[i] * 0.25;
    }
    for (const [a, b] of links) {
      const vx = x[a] - x[b];
      const vy = y[a] - y[b];
      const f = Math.sqrt(vx * vx + vy * vy) / k;
      dx[a] -= vx * f; dy[a] -= vy * f;
      dx[b] += vx * f; dy[b] += vy * f;
    }
    const heat = (size / 8) * (1 - step / iterations) + 0.5;
    for (let i = 0; i < n; i++) {
      const d = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]) || 1;
      const move = Math.min(d, heat);
      x[i] += (dx[i] / d) * move;
      y[i] += (dy[i] / d) * move;
    }
  }
  return new Map(ids.map((id, i) => [id, { x: x[i], y: y[i] }]));
}
