import react from "@vitejs/plugin-react";
import type { IncomingMessage } from "node:http";
import { defineConfig, type Plugin } from "vite";

import { createBackend } from "./mock/backend.ts";
import pkg from "./package.json" with { type: "json" };

/* В разработке интерфейс ходит в API по относительному пути /api:
     npm run dev        — прокси на настоящий API (VITE_API_TARGET, по умолчанию :8080)
     npm run dev:mock   — фейковый API в памяти, без Neo4j и vLLM
   В собранном виде /api проксирует nginx интерфейса (nginx.conf.template). */

/* Тело запроса: JSON — разобранным, форма фейкового Keycloak — строкой. */
const readBody = (req: IncomingMessage) =>
  new Promise<unknown>((resolve) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (!raw) { resolve(undefined); return; }
      if (!String(req.headers["content-type"] ?? "").includes("json")) { resolve(raw); return; }
      try { resolve(JSON.parse(raw)); } catch { resolve(undefined); }
    });
  });

function mockApi(): Plugin {
  // Обучение по интерфейсу показывается при первом входе каждой учётки — до перезапуска.
  const backend = createBackend({ firstLogin: true });
  return {
    name: "mock-api",
    configureServer(server) {
      server.middlewares.use("/api", async (req, res) => {
        const body = await readBody(req);
        const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v ?? "")]));
        const reply = backend.handle(req.method ?? "GET", req.url ?? "/", body, headers);
        res.statusCode = reply.status;
        for (const [name, value] of Object.entries(reply.headers ?? {})) res.setHeader(name, value);
        if (reply.status === 204 || reply.status === 302) { res.end(); return; }
        res.setHeader("Content-Type", reply.contentType ?? "application/json");
        res.end(reply.contentType ? String(reply.body) : JSON.stringify(reply.body));
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === "mock" ? [mockApi()] : [])],
  // Версия из package.json — подпись на экране входа.
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: {
    port: 5173,
    proxy: mode === "mock" ? undefined : {
      "/api": {
        target: process.env.VITE_API_TARGET ?? "http://localhost:8080",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
}));
