/* Записывает видео эмблемы для экрана входа: светлую и тёмную темы.
     node tools/emblem/record.mjs            (из папки web; нужны Chrome и ffmpeg)
   Поднимает Vite, открывает сцену scene.js в Chrome без окна (через видеокарту),
   снимает кадры по точному времени и собирает ролики в src/assets:
   login-emblem-<тема>.webm (VP9), .mp4 (H.264 — для Safari), .webp (первый кадр,
   заставка до загрузки видео и картинка при «уменьшить движение»). */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createServer } from "vite";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = join(WEB, "src/assets"), SIZE = 1000, FPS = 24;
const COLOR = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"];

const server = await createServer({ root: WEB, logLevel: "error", server: { port: 0 } });
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } });
    await page.goto(`${base}tools/emblem/?theme=${theme}&size=${SIZE}`);
    await page.waitForFunction(() => window.ready, null, { timeout: 60_000 });
    const gpu = await page.evaluate(() => { const gl = document.querySelector("canvas").getContext("webgl2");
      const i = gl?.getExtension("WEBGL_debug_renderer_info"); return i ? gl.getParameter(i.UNMASKED_RENDERER_WEBGL) : ""; });
    if (/swiftshader|llvmpipe|software/i.test(gpu)) throw new Error(`программный WebGL: ${gpu}`);
    const loop = await page.evaluate(() => window.LOOP), frames = loop * FPS;
    const dir = mkdtempSync(join(tmpdir(), `emblem-${theme}-`));
    const poster = await page.evaluate(() => { window.renderAt(0); return document.querySelector("canvas").toDataURL("image/webp", .86); });
    writeFileSync(join(OUT, `login-emblem-${theme}.webp`), Buffer.from(poster.split(",")[1], "base64"));
    for (let f = 0; f < frames; f++) {
      const url = await page.evaluate((t) => { window.renderAt(t); return document.querySelector("canvas").toDataURL("image/png"); }, f / FPS);
      writeFileSync(join(dir, `${String(f).padStart(4, "0")}.png`), Buffer.from(url.split(",")[1], "base64"));
    }
    await page.close();
    const input = ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", join(dir, "%04d.png")];
    const yuv = ["-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p", ...COLOR];
    const run = (args) => { const r = spawnSync("ffmpeg", args, { stdio: "inherit" }); if (r.status) throw new Error("ffmpeg: " + args.at(-1)); };
    run([...input, ...yuv, "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "46", "-row-mt", "1", "-deadline", "good", "-cpu-used", "2", "-an", join(OUT, `login-emblem-${theme}.webm`)]);
    run([...input, ...yuv, "-c:v", "libx264", "-preset", "slow", "-crf", "31", "-tag:v", "avc1", "-movflags", "+faststart", "-an", join(OUT, `login-emblem-${theme}.mp4`)]);
    rmSync(dir, { recursive: true, force: true });
    console.log(`${theme}: ${frames} кадров, ${gpu}`);
  }
} finally {
  await browser.close(); await server.close();
}
