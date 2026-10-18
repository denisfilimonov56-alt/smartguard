import { defineConfig } from "@playwright/test";

/* e2e-тесты интерфейса. Гоняются на собранной версии (vite preview),
   API подменяется фейком из mock/backend.ts — свой экземпляр на каждый тест.

   Браузер: по умолчанию Chromium из `npx playwright install chromium`;
   PW_CHANNEL=chrome берёт установленный Google Chrome без скачивания. */

export default defineConfig({
  testDir: "tests",
  fullyParallel: true,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:4173",
    channel: process.env.PW_CHANNEL || undefined,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run build && npx vite preview --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
