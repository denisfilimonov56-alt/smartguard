/* Сцена эмблемы из частиц для записи видео экрана входа (record.mjs).
   Та же эмблема, что раньше рисовалась на сайте через three.js, но:
   - случайные числа из генератора с зерном — запись повторяется один в один;
   - все движения периодичны с периодом LOOP: покачивание — один период, дрожание
     частиц — 4 и 3 периода, орбиты поворачиваются на целое число шагов пунктира,
     поэтому последний кадр переходит в первый без шва;
   - кадр рисуется по заданному времени (window.renderAt), а не по часам.
   Фон кадра — чистый белый или чёрный (см. ниже). Открывается dev-сервером Vite: /tools/emblem/?theme=light|dark&size=1200 */
import * as THREE from "three";
import logo from "../../src/assets/logo.png";

const LOOP = 18;   // секунд в ролике
const params = new URLSearchParams(location.search);
const DARK = params.get("theme") === "dark", SIZE = Number(params.get("size") || 1200);
const PR = 1.34 * SIZE / 1200;   // размер частиц относительно эмблемы — как на сайте при плотности 1.75

let seed = 20261103;
const rnd = () => { seed |= 0; seed = seed + 0x6d2b79f5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

const canvas = document.getElementById("c");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(1); renderer.setSize(SIZE, SIZE, false);
const camera = new THREE.PerspectiveCamera(42, 1, .1, 200); camera.position.set(0, 0, 15);
// Фон чисто белый / чисто чёрный: на сайте ролик накладывается «умножением» (светлая тема)
// или «экраном» (тёмная) — такой фон исчезает точно, без рамки и полос на любом фоне страницы.
const scene = new THREE.Scene(); scene.background = new THREE.Color(DARK ? 0x000000 : 0xffffff);

/* ---------- точки эмблемы из картинки ---------- */
const img = new Image();
await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = logo; });
const N = 16000, HALO = 1600, W = 190, H = Math.round(W * img.height / img.width), S = 6.2;
const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
const cx = cv.getContext("2d", { willReadFrequently: true }); cx.drawImage(img, 0, 0, W, H);
const px = cx.getImageData(0, 0, W, H).data, src = [];
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = (y * W + x) * 4;
  if (px[i + 3] > 140) src.push([x, y, px[i] < 40 ? 0 : px[i] > 110 ? 2 : 1]);   // центр, крылья, ромб — по красному каналу
}
const TONES = (DARK ? [0x5ea2ff, 0x2f86ff, 0xa9cbff] : [0x0a4fc4, 0x2a7bf0, 0x9cc5fa]).map((c) => new THREE.Color(c));
const POS = new Float32Array(N * 3), COL = new Float32Array(N * 3), SEED = new Float32Array(N), SCL = new Float32Array(N);
for (let i = 0; i < N; i++) {
  const s = src[Math.floor(rnd() * src.length)];
  POS.set([((s[0] + rnd() - .5) / W - .5) * S, -((s[1] + rnd() - .5) / H - .5) * S * H / W, (rnd() - .5) * .45], i * 3);
  TONES[s[2]].toArray(COL, i * 3); SEED[i] = rnd() * 100; SCL[i] = .55 + rnd() * .9;
}

/* ---------- частицы и ореолы ---------- */
const geo = new THREE.BufferGeometry();
geo.setAttribute("position", new THREE.BufferAttribute(POS, 3)); geo.setAttribute("color", new THREE.BufferAttribute(COL, 3));
geo.setAttribute("aSeed", new THREE.BufferAttribute(SEED, 1)); geo.setAttribute("aScale", new THREE.BufferAttribute(SCL, 1));
const W1 = 2 * Math.PI * 4 / LOOP, W2 = 2 * Math.PI * 3 / LOOP;
const uni = { uTime: { value: 0 }, uPR: { value: PR } };
const VS = `attribute vec3 color; attribute float aSeed, aScale; uniform float uTime, uPR, uK; varying vec3 vC;
  void main(){ vec3 p = position;
    p.x += sin(uTime*${W1.toFixed(6)} + aSeed) * .035; p.y += cos(uTime*${W2.toFixed(6)} + aSeed*1.7) * .035;
    vC = color; vec4 mv = modelViewMatrix * vec4(p, 1.); gl_Position = projectionMatrix * mv;
    gl_PointSize = 3.1 * uPR * aScale * uK * (10. / -mv.z); }`;
const points = (k, fs) => new THREE.ShaderMaterial({ uniforms: { ...uni, uK: { value: k } }, vertexShader: VS, fragmentShader: fs, transparent: true, depthWrite: false });
const mat = points(1.3, `varying vec3 vC;
  void main(){ float d = length(gl_PointCoord - .5); float a = smoothstep(.5, .0, d); a = a * (.35 + .65 * a);
    gl_FragColor = vec4(vC, min(1., a * 1.3));
    #include <colorspace_fragment>
  }`);
const haloMat = points(12 * 1.3, `varying vec3 vC;
  void main(){ float d = length(gl_PointCoord - .5) * 2.;
    gl_FragColor = vec4(vC, exp(-d*d*4.) * (1. - smoothstep(.7, 1., d)) * ${DARK ? ".11" : ".056"});
    #include <colorspace_fragment>
  }`);
const ZOOM = 1.12;   // эмблема с внутренней орбитой — около половины кадра, внешняя орбита у края
const group = new THREE.Group(); group.scale.setScalar(ZOOM); scene.add(group);
const haloGeo = new THREE.BufferGeometry();
for (const [k, v] of Object.entries(geo.attributes)) haloGeo.setAttribute(k, v);
haloGeo.setDrawRange(0, HALO);
group.add(new THREE.Points(haloGeo, haloMat), new THREE.Points(geo, mat));

/* ---------- пунктирные орбиты: штрих — 4 мягкие точки ---------- */
const ringColor = new THREE.Color(DARK ? 0x4d97ff : 0x0c6ff1);
const rings = [[3.9, .4, 26], [5.1, .24, -23]].map(([r, o, steps]) => {
  const pts = [];
  for (let a = 0, step = .04 / r; a < Math.PI * 2 - .2 / r; a += .32 / r)
    for (let j = 0; j < 4; j++) pts.push(Math.cos(a + j * step) * r, Math.sin(a + j * step) * r, 0);
  const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  const ring = new THREE.Points(g, new THREE.ShaderMaterial({
    uniforms: { uPR: uni.uPR, uC: { value: ringColor }, uO: { value: o } }, transparent: true, depthWrite: false,
    vertexShader: `uniform float uPR; void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); gl_PointSize = 2.4 * uPR; }`,
    fragmentShader: `uniform vec3 uC; uniform float uO;
      void main(){ float d = length(gl_PointCoord - .5); gl_FragColor = vec4(uC, uO * smoothstep(.5, .1, d));
        #include <colorspace_fragment>
      }` }));
  ring.scale.setScalar(ZOOM); ring.rotation.x = 1.25; ring.userData.speed = steps * (.32 / r) / LOOP;   // за ролик — целое число шагов пунктира
  scene.add(ring); return ring;
});

/* ---------- пыль ---------- */
const dust = new Float32Array(900 * 3);
for (let i = 0; i < 900; i++) dust.set([(rnd() - .5) * 60, (rnd() - .5) * 36, -rnd() * 48 - 4], i * 3);
const dustGeo = new THREE.BufferGeometry(); dustGeo.setAttribute("position", new THREE.BufferAttribute(dust, 3));
scene.add(new THREE.Points(dustGeo, new THREE.PointsMaterial({ color: DARK ? 0x4d97ff : 0x8ab8f8, size: 1.6 * PR, sizeAttenuation: false, transparent: true, opacity: .6 })));

/* ---------- кадр по времени ---------- */
window.LOOP = LOOP;
window.renderAt = (t) => {
  uni.uTime.value = t;
  group.rotation.y = Math.sin(2 * Math.PI * t / LOOP) * .38;   // покачивание: один период за ролик
  for (const r of rings) r.rotation.z = t * r.userData.speed;
  renderer.render(scene, camera);
};
window.renderAt(0);
window.ready = true;
