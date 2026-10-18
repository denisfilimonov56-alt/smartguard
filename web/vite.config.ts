import react from "@vitejs/plugin-react";
import type { IncomingMessage } from "node:http";
import { defineConfig, type Plugin } from "vite";

import { createBackend } from "./mock/backend.ts";

/* В разработке интерфейс ходит в API по относительному пути /api:
     npm run dev        — прокси на настоящий API (VITE_API_TARGET, по умолчанию :8080)
     npm run dev:mock   — фейковый API в памяти, без Neo4j и vLLM
   В собранном виде /api проксирует nginx интерфейса (nginx.conf.template). */

const readBody = (req: IncomingMessage) =>
  new Promise<unknown>((resolve) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : undefined); } catch { resolve(undefined); }
    });
  });

function mockApi(): Plugin {
  const backend = createBackend();
  return {
    name: "mock-api",
    configureServer(server) {
      server.middlewares.use("/api", async (req, res) => {
        const body = await readBody(req);
        const reply = backend.handle(req.method ?? "GET", req.url ?? "/", body);
        res.statusCode = reply.status;
        if (reply.status === 204) { res.end(); return; }
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(reply.body));
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === "mock" ? [mockApi()] : [])],
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
