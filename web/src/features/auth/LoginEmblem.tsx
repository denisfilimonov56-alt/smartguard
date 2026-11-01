import { useEffect, useRef, useState } from "react";

import logo from "../../assets/logo.png";

/* Эмблема из частиц на экране входа (three.js, WebGL). При загрузке частицы
   слетаются из облака в эмблему, она мягко покачивается; пока курсор на кнопке
   «Войти» — цвет глубже и ореол сильнее; по нажатию частицы улетают на зрителя.
   Только белый вариант: частицы ложатся обычным наложением, у центра шеврона,
   крыльев и ромба свои оттенки синего (исходные на белом почти сливаются).

   Устроено так, чтобы не тормозить на слабых машинах:
   - three.js грузится отдельным чанком уже после того, как экран входа показан;
   - переход между формами считается в вершинном шейдере (aA → aB за uDur
     с задержкой на частицу); CPU пересчитывает положения только в момент
     нового перехода, поэтому прерванный переход продолжается без скачка;
   - свечение — не постобработка (bloom давал квадратные ореолы), а «ореолы»:
     первые HALO частиц второй раз рисуются крупными пятнами с гауссовым спадом;
   - качество снижается ступенями по фактическому FPS и обратно не растёт:
     0 — полная плотность пикселей; 1 — плотность 1; 2 — без ореолов;
     3 — половина частиц и плотность 0.75. Слабая машина (≤4 ядер или ≤4 ГБ)
     сразу стартует с уровня 1 и с меньшим числом частиц.
   Без WebGL показывается обычная картинка эмблемы. */

interface Signals { active: boolean; leaving: boolean }

export function LoginEmblem({ active, leaving }: Signals) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const signals = useRef<Signals>({ active, leaving });
  const [failed, setFailed] = useState(false);

  useEffect(() => { signals.current = { active, leaving }; }, [active, leaving]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let stop: (() => void) | undefined, dead = false;
    startScene(canvas, signals).then((s) => { if (dead) s(); else stop = s; }, () => { if (!dead) setFailed(true); });
    return () => { dead = true; stop?.(); };
  }, []);

  if (failed) return <img className="login-emblem-fallback" src={logo} alt="" />;
  return <canvas ref={canvasRef} className="login-emblem" aria-hidden="true" />;
}

const ease = (t: number) => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

async function startScene(canvas: HTMLCanvasElement, signals: { current: Signals }): Promise<() => void> {
  const THREE = await import("three");
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const nav = navigator as Navigator & { deviceMemory?: number };
  const weak = (nav.hardwareConcurrency || 8) <= 4 || (nav.deviceMemory || 8) <= 4;
  let level = weak ? 1 : 0;
  const prFor = (l: number) => (l === 0 ? Math.min(devicePixelRatio, 1.75) : l === 3 ? .75 : 1);
  const narrow = () => canvas.clientWidth < 760;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: "high-performance" });
  // Программный WebGL (виртуальные рабочие места без видеокарты, headless-браузер в тестах)
  // считает частицы на процессоре — там вместо сцены обычная картинка эмблемы.
  const gl = renderer.getContext(), info = gl.getExtension("WEBGL_debug_renderer_info");
  const gpu = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
  if (/swiftshader|llvmpipe|softpipe|software|basic render/i.test(gpu)) { renderer.dispose(); throw new Error("программный WebGL"); }
  const camera = new THREE.PerspectiveCamera(42, 1, .1, 200);
  camera.position.set(0, 0, 15);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xffffff);

  /* ---------- эмблема из картинки ---------- */
  // не img.decode(): в фоновой вкладке он может не завершиться, и сцена не стартует
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = logo; });
  const N = weak ? 9000 : 16000, HALO = weak ? 700 : 1600;
  const W = 190, H = Math.round(W * img.height / img.width), S = 6.2;
  const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  if (!cx) throw new Error("canvas 2d недоступен");
  cx.drawImage(img, 0, 0, W, H);
  const px = cx.getImageData(0, 0, W, H).data, src: [number, number, number][] = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    if (px[i + 3] <= 140) continue;
    // часть эмблемы по красному каналу: центр шеврона тёмный, крылья средние, ромб светлый
    src.push([x, y, px[i] < 40 ? 0 : px[i] > 110 ? 2 : 1]);
  }
  const TONES = [new THREE.Color(0x0a4fc4), new THREE.Color(0x2a7bf0), new THREE.Color(0x9cc5fa)];
  const EMB = new Float32Array(N * 3), COL = new Float32Array(N * 3), SCATTER = new Float32Array(N * 3);
  const delay = new Float32Array(N), seed = new Float32Array(N), scl = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const s = src[Math.floor(Math.random() * src.length)];
    EMB.set([((s[0] + Math.random() - .5) / W - .5) * S, -((s[1] + Math.random() - .5) / H - .5) * S * H / W, (Math.random() - .5) * .45], i * 3);
    TONES[s[2]].toArray(COL, i * 3);
    const u = Math.random() * Math.PI * 2, v = Math.acos(2 * Math.random() - 1), r = 10 + Math.random() * 16;
    SCATTER.set([Math.sin(v) * Math.cos(u) * r, Math.sin(v) * Math.sin(u) * r * .6, Math.cos(v) * r], i * 3);
    delay[i] = Math.random() * .9; seed[i] = Math.random() * 100; scl[i] = .55 + Math.random() * .9;
  }

  /* ---------- частицы ---------- */
  const geo = new THREE.BufferGeometry();
  const A = new Float32Array(N * 3), B = new Float32Array(N * 3);
  const attr = (name: string, arr: Float32Array, d: number) => { const a = new THREE.BufferAttribute(arr, d); geo.setAttribute(name, a); return a; };
  const aA = attr("aA", A, 3), aB = attr("aB", B, 3);
  attr("color", COL, 3); attr("aDelay", delay, 1); attr("aSeed", seed, 1); attr("aScale", scl, 1);
  attr("position", new Float32Array(N * 3), 3);   // для three.js; настоящее положение — в шейдере
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 30);
  const uni = { uP: { value: 0 }, uDur: { value: 2.6 }, uDK: { value: 1 }, uTime: { value: 0 }, uNoise: { value: .035 },
    uSize: { value: 3.1 }, uPR: { value: 1 }, uActive: { value: 0 } };
  const VS = `
    attribute vec3 aA, aB, color; attribute float aDelay, aSeed, aScale;
    uniform float uP, uDur, uDK, uTime, uNoise, uSize, uPR, uActive, uK;
    varying vec3 vC;
    float ez(float t){ return t < .5 ? 4.*t*t*t : 1. - pow(-2.*t + 2., 3.) / 2.; }
    void main(){
      float k = ez(clamp((uP - aDelay*uDK) / (uDur*.6), 0., 1.));
      vec3 p = mix(aA, aB, k);
      p.x += sin(uTime*1.3 + aSeed) * uNoise; p.y += cos(uTime*1.1 + aSeed*1.7) * uNoise;
      vC = color * (1. - uActive * .18);              // наведение на «Войти» — цвет глубже
      vec4 mv = modelViewMatrix * vec4(p, 1.); gl_Position = projectionMatrix * mv;
      gl_PointSize = uSize * uPR * aScale * uK * (10. / -mv.z);
    }`;
  const points = (k: number, fs: string) => new THREE.ShaderMaterial({ uniforms: { ...uni, uK: { value: k } }, vertexShader: VS,
    fragmentShader: fs, transparent: true, depthWrite: false });
  // #include <colorspace_fragment> — перевод в sRGB: постобработки нет, больше его никто не сделает
  const mat = points(1.3, `varying vec3 vC;
    void main(){ float d = length(gl_PointCoord - .5); float a = smoothstep(.5, .0, d); a = a * (.35 + .65 * a);
      gl_FragColor = vec4(vC, min(1., a * 1.3));
      #include <colorspace_fragment>
    }`);
  const haloMat = points(12 * 1.3, `uniform float uActive; varying vec3 vC;
    void main(){ float d = length(gl_PointCoord - .5) * 2.;
      float a = exp(-d*d*4.) * (1. - smoothstep(.7, 1., d)) * .056 * (1. + uActive * .8);
      gl_FragColor = vec4(vC, a);
      #include <colorspace_fragment>
    }`);
  const group = new THREE.Group(); scene.add(group);
  const haloGeo = new THREE.BufferGeometry();   // ореолы — общие буферы, только первые HALO частиц
  for (const [k, v] of Object.entries(geo.attributes)) haloGeo.setAttribute(k, v);
  haloGeo.boundingSphere = geo.boundingSphere; haloGeo.setDrawRange(0, HALO);
  const halo = new THREE.Points(haloGeo, haloMat);
  group.add(halo, new THREE.Points(geo, mat));

  // пунктирные орбиты вокруг эмблемы
  const rings = ([[3.9, .4], [5.1, .24]] as const).map(([r, o]) => {
    const ring = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(new THREE.EllipseCurve(0, 0, r, r).getPoints(160).map((p) => new THREE.Vector3(p.x, p.y, 0))),
      new THREE.LineDashedMaterial({ color: 0x0c6ff1, transparent: true, opacity: o, dashSize: .12, gapSize: .2 }));
    ring.computeLineDistances(); ring.rotation.x = 1.25; group.add(ring); return ring;
  });
  // фоновая пыль — по одной вершине на точку
  const dustGeo = new THREE.BufferGeometry();
  {
    const n = weak ? 400 : 900, p = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) p.set([(Math.random() - .5) * 60, (Math.random() - .5) * 36, -Math.random() * 48 - 4], i * 3);
    dustGeo.setAttribute("position", new THREE.BufferAttribute(p, 3));
  }
  const dustMat = new THREE.PointsMaterial({ color: 0x8ab8f8, size: 1.6, sizeAttenuation: false, transparent: true, opacity: .6 });
  scene.add(new THREE.Points(dustGeo, dustMat));

  /* ---------- переходы ---------- */
  const clock = new THREE.Clock(); const now = () => clock.getElapsedTime();
  let t0 = 0, warping = false;
  function current(i: number, q: number, P: number) {
    const k = ease(clamp01((P - delay[i] * uni.uDK.value) / (uni.uDur.value * .6))), j = i * 3 + q;
    return A[j] + (B[j] - A[j]) * k;
  }
  function morph(to: Float32Array, dur: number, dk: number) {
    const P = now() - t0;
    for (let i = 0; i < N; i++) for (let q = 0; q < 3; q++) A[i * 3 + q] = current(i, q, P);
    B.set(to); aA.needsUpdate = aB.needsUpdate = true;
    uni.uDur.value = dur; uni.uDK.value = dk; t0 = now();
  }
  A.set(still ? EMB : SCATTER); B.set(EMB);   // старт: из облака в эмблему

  /* ---------- кадр ---------- */
  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h); camera.fov = w < 760 ? 58 : 42; camera.updateProjectionMatrix();
    // правее центра, но не дальше видимого края: на средней ширине эмблема не уезжает за экран
    const halfW = Math.tan(camera.fov * Math.PI / 360) * camera.position.z * camera.aspect;
    const nx = narrow(); group.position.set(nx ? 0 : Math.min(3.9, halfW - 3.6), nx ? 2.2 : 0, 0); group.scale.setScalar(nx ? .62 : 1);
    uni.uSize.value = nx ? 2.5 : 3.1;
    if (still) draw(30, .016);
  }
  function applyLevel() {
    renderer.setPixelRatio(prFor(level)); uni.uPR.value = renderer.getPixelRatio();
    halo.visible = level < 2; geo.setDrawRange(0, level >= 3 ? N >> 1 : N); resize();
  }
  const pointer = { x: 0, y: 0, sx: 0, sy: 0 };
  const onMove = (e: PointerEvent) => { pointer.x = e.clientX / innerWidth * 2 - 1; pointer.y = -(e.clientY / innerHeight * 2 - 1); };
  let rotY = 0, act = 0;
  function draw(t: number, dt: number) {
    uni.uTime.value = t; uni.uP.value = t - t0;
    const { active, leaving } = signals.current;
    if (leaving && !warping && !still) {   // «Войти» нажата — частицы улетают на зрителя
      const P = now() - t0, w = new Float32Array(N * 3);
      for (let i = 0; i < N; i++) w.set([current(i, 0, P) * 4, current(i, 1, P) * 4, 22 + Math.random() * 8], i * 3);
      morph(w, 1.4, .35); warping = true;
    } else if (!leaving && warping) {      // вход не начался (ошибка) — эмблема собирается обратно
      morph(EMB, 2.4, 1); warping = false;
    }
    pointer.sx += (pointer.x - pointer.sx) * Math.min(1, dt * 3); pointer.sy += (pointer.y - pointer.sy) * Math.min(1, dt * 3);
    rotY += (Math.sin(t * .35) * .38 - rotY) * Math.min(1, dt * 2);
    // эмблема правее центра, камера видит её под углом: базовый поворот — лицом к камере,
    // иначе одинаковое покачивание кажется сильнее в одну сторону
    const face = Math.atan2(-group.position.x, camera.position.z - group.position.z);
    group.rotation.y = face + rotY + pointer.sx * .12; group.rotation.x = -pointer.sy * .12;
    act += ((active ? 1 : 0) - act) * Math.min(1, dt * 3);
    uni.uActive.value = act;
    rings.forEach((r, i) => { r.rotation.z = t * (i ? -.08 : .12); });
    renderer.render(scene, camera);
  }

  // замер FPS: после разогрева окна по 2 с; среднее хуже 45 FPS — ступень вниз.
  // Если тормозит и на последней ступени — эмблема застывает собранной, анимация останавливается.
  let raf = 0, last = 0, prev = 0, acc = 0, frames = 0, watchFrom = 1.5;
  function frame() {
    raf = requestAnimationFrame(frame);
    if (document.hidden) { acc = frames = 0; return; }
    const t = now(), dt = Math.min(.05, t - last); last = t;
    draw(t, dt);
    if (t > watchFrom) {
      const step = t - prev;
      if (step < .25) { acc += step; frames++; }   // паузы (свёрнутое окно) не считаем
      if (acc > 2) {
        if (acc / frames > 1 / 45) {
          if (level < 3) { level++; applyLevel(); watchFrom = t + 1; }
          else { cancelAnimationFrame(raf); A.set(EMB); B.set(EMB); aA.needsUpdate = aB.needsUpdate = true; draw(t, 1); return; }
        }
        acc = frames = 0;
      }
    }
    prev = t;
  }

  const ro = new ResizeObserver(resize); ro.observe(canvas);
  addEventListener("pointermove", onMove);
  applyLevel();
  if (still) { t0 = -30; draw(30, .016); } else frame();

  return () => {
    cancelAnimationFrame(raf); ro.disconnect(); removeEventListener("pointermove", onMove);
    for (const o of [geo, haloGeo, dustGeo, mat, haloMat, dustMat, ...rings.flatMap((r) => [r.geometry, r.material])]) o.dispose();
    renderer.dispose();
  };
}
