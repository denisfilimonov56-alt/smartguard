import { useEffect, useRef } from "react";

/* Фон интерфейса: точечная сетка с шагом 14px, по
   которой плывёт шумовое поле. Вне «облака» точки едва заметны (цвет
   --login-dot); там, где поле выше порога, точки растут и наливаются
   фирменным синим (--cloud-dot) — к сердцевине облака сильнее, к краю слабее.
   Один фиксированный canvas под всем содержимым (z-index:-1); цвета берутся
   из токенов темы (ui/theme.ts). При prefers-reduced-motion рисуется один
   неподвижный кадр; в скрытой вкладке и в окне без фокуса анимация
   останавливается (последний кадр остаётся на месте).

   Фон лежит под всем приложением, поэтому он дешёвый: насыщенность точки
   квантуется до LEVELS ступеней, и все точки одной ступени рисуются одним
   path и одним fill — несколько вызовов отрисовки на кадр вместо десятков
   тысяч, без сборки строки цвета на каждую точку. Облака плывут медленно,
   так что 12 кадров в секунду на глаз не отличить от 30. */

const STEP = 14;          // шаг сетки
const BASE_R = 0.75;      // радиус точки вне облака
const CLOUD_R = 1.25;     // радиус точки в сердцевине облака
const FPS = 12;
const LEVELS = 8;         // ступени насыщенности: 0 — фон, LEVELS-1 — сердцевина облака
const SPEED = 0.09;       // скорость дрейфа поля (единиц шума в секунду)

/* Детерминированный хеш целочисленной точки → [0,1). */
function hash(x: number, y: number, z: number) {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const fade = (t: number) => t * t * (3 - 2 * t);
/* Трёхмерный value-noise: плавная интерполяция хешей по кубу решётки. */
function noise(x: number, y: number, z: number) {
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  const fx = fade(x - x0), fy = fade(y - y0), fz = fade(z - z0);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const n = (dx: number, dy: number, dz: number) => hash(x0 + dx, y0 + dy, z0 + dz);
  return lerp(
    lerp(lerp(n(0, 0, 0), n(1, 0, 0), fx), lerp(n(0, 1, 0), n(1, 1, 0), fx), fy),
    lerp(lerp(n(0, 0, 1), n(1, 0, 1), fx), lerp(n(0, 1, 1), n(1, 1, 1), fx), fy),
    fz,
  );
}

type Rgba = { r: number; g: number; b: number; a: number };
function token(name: string, fallback: Rgba): Rgba {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const m = raw.match(/rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+))?\s*\)/);
  if (!m) return fallback;
  return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
}
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

export function CloudField() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let base = token("--login-dot", { r: 12, g: 111, b: 241, a: 0.16 });
    let cloud = token("--cloud-dot", { r: 12, g: 111, b: 241, a: 0.6 });
    let width = 0, height = 0, dpr = 1;
    let timer = 0, lastDraw = 0;
    /** Цвет и радиус каждой ступени — пересчитываются только при смене темы. */
    let styles: { fill: string; r: number }[] = [];
    const paint = () => {
      styles = Array.from({ length: LEVELS }, (_, level) => {
        const k = level / (LEVELS - 1);
        const c = { r: mix(base.r, cloud.r, k), g: mix(base.g, cloud.g, k), b: mix(base.b, cloud.b, k), a: mix(base.a, cloud.a, k) };
        return { fill: `rgba(${c.r | 0},${c.g | 0},${c.b | 0},${c.a})`, r: mix(BASE_R, CLOUD_R, k) };
      });
    };
    paint();
    /** Ступень каждой точки сетки за кадр; переиспользуется между кадрами. */
    let levels = new Uint8Array(0);
    const start = performance.now();
    const seed = Math.floor(Math.random() * 1e6);   // рисунок отличается от загрузки к загрузке

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const draw = (now: number) => {
      const t = reduced.matches ? 0 : ((now - start) / 1000) * SPEED;
      const cols = Math.ceil((width + STEP / 2) / STEP);
      const rows = Math.ceil((height + STEP / 2) / STEP);
      if (levels.length !== cols * rows) levels = new Uint8Array(cols * rows);
      for (let j = 0; j < rows; j++) {
        const y = STEP / 2 + j * STEP;
        for (let i = 0; i < cols; i++) {
          const x = STEP / 2 + i * STEP;
          // Крупные облака (~250px) вытянуты по горизонтали, мелкий шум рвёт
          // их края; масштаб в пикселях, поэтому не зависит от шага сетки.
          const big = noise(x / 250 + seed, y / 125 + seed, t);
          const fine = noise(x / 85 + seed * 2, y / 55 + seed * 2, t * 1.7 + 7);
          const v = big * 0.72 + fine * 0.28;
          const k = fade(Math.max(0, Math.min(1, (v - 0.52) / 0.26)));  // 0 вне облака … 1 в сердцевине
          levels[j * cols + i] = Math.round(k * (LEVELS - 1));
        }
      }
      ctx.clearRect(0, 0, width, height);
      for (let level = 0; level < LEVELS; level++) {
        const { fill, r } = styles[level];
        ctx.beginPath();
        for (let j = 0, n = 0; j < rows; j++) {
          const y = STEP / 2 + j * STEP;
          for (let i = 0; i < cols; i++, n++) {
            if (levels[n] !== level) continue;
            const x = STEP / 2 + i * STEP;
            ctx.moveTo(x + r, y);
            ctx.arc(x, y, r, 0, Math.PI * 2);
          }
        }
        ctx.fillStyle = fill;
        ctx.fill();
      }
    };

    const tick = () => {
      const now = performance.now();
      if (now - lastDraw >= 1000 / FPS - 2) { lastDraw = now; draw(now); }
      timer = reduced.matches || !focused ? 0 : requestAnimationFrame(tick);
    };
    // Окно без фокуса (работают в другом приложении, RDP в фоне) — фон замирает.
    let focused = document.hasFocus();
    const run = () => {
      cancelAnimationFrame(timer);
      timer = 0;
      if (document.visibilityState === "hidden") return;
      if (!focused || reduced.matches) { draw(performance.now()); return; }
      timer = requestAnimationFrame(tick);
    };
    const onFocus = () => { focused = true; run(); };
    const onBlur = () => { focused = false; run(); };

    const onResize = () => { resize(); if (!timer) draw(performance.now()); };
    const onTheme = () => {
      base = token("--login-dot", base);
      cloud = token("--cloud-dot", cloud);
      paint();
      if (!timer) draw(performance.now());
    };
    const themeObserver = new MutationObserver(onTheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    // Смена системной темы без выбранной вручную меняет data-theme (ui/theme.ts); подписка на
    // саму системную тему — на случай, когда токены переопределены только медиазапросом.
    const scheme = matchMedia("(prefers-color-scheme: dark)");
    scheme.addEventListener("change", onTheme);

    resize();
    run();
    window.addEventListener("resize", onResize);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", run);
    reduced.addEventListener("change", run);
    return () => {
      cancelAnimationFrame(timer);
      themeObserver.disconnect();
      scheme.removeEventListener("change", onTheme);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", run);
      reduced.removeEventListener("change", run);
    };
  }, []);

  return <canvas ref={ref} className="cloud-field" aria-hidden="true" />;
}
