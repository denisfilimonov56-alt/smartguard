import { expect, go, orderItem, panel, test } from "./fixtures";

/* Проверка примеров на модели в разделе «Замечания». Фейк определяет атрибуты
   по ключевым словам: три примера из его данных пометкам соответствуют. */

const VAGUE = "Завершить внедрение в ближайшее время";

/** Завести пример в обход интерфейса: сам редактор примеров проверяется в rules.spec.ts. */
const addExample = (page: import("@playwright/test").Page, ruleNodeId: string, text: string, isViolation: boolean) =>
  page.evaluate(async (body) => {
    await fetch("/api/catalog/examples", {
      method: "POST", headers: { "X-Requested-With": "XMLHttpRequest", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }, { ruleNodeId, text, isViolation });

const block = (page: import("@playwright/test").Page) => page.locator("#examplesCheck");

test("примеры, которые модель подтверждает", async ({ app }) => {
  await go(app, /Замечания/);
  await expect(block(app).getByText("Проверка ещё не запускалась.")).toBeVisible();
  await block(app).getByRole("button", { name: "Проверить примеры" }).click();
  await expect(block(app).getByText("Модель подтверждает примеры")).toBeVisible();
  await expect(block(app)).toContainText("совпало: 3 · расхождений: 0 · не проверено: 0 · пропущено: 0");
  await expect(block(app).locator(".issue")).toHaveCount(0);
});

test("расхождение объясняется и ведёт к примеру", async ({ app }) => {
  // Корректный пример правила о сроке, в котором срока нет.
  await addExample(app, "r:2", VAGUE, false);
  await app.reload();
  await go(app, /Замечания/);
  await block(app).getByRole("button", { name: "Проверить примеры" }).click();
  await expect(block(app).getByText("Расхождений: 1", { exact: true })).toBeVisible();

  const mismatch = block(app).locator('.issue[data-outcome="mismatched"]');
  await expect(mismatch).toContainText(`«${VAGUE}»`);
  await expect(mismatch).toContainText("R-2.4 · приказ ПР-01 · п. 2.4");
  await expect(mismatch).toContainText("Корректный пример, но модель не нашла в нём «срок_исполнения»");

  await mismatch.getByRole("button", { name: "Показать" }).click();
  await expect(app.getByRole("tab", { name: "Приказы" })).toHaveAttribute("aria-selected", "true");
  await expect(orderItem(app, "ПР-01")).toHaveAttribute("aria-selected", "true");
  await expect(panel(app)).toContainText(VAGUE);

  // Каталог поменяли — результат помечается устаревшим.
  await addExample(app, "r:2", "Сдать отчёт до 01.03.2026", false);
  await go(app, /Замечания/);
  await expect(block(app).getByText("Каталог менялся после проверки")).toBeVisible();
});

test.describe("читатель", () => {
  test.use({ role: "viewer" });

  test("видит блок, но запустить проверку не может", async ({ app }) => {
    await go(app, /Замечания/);
    await expect(block(app).getByText("Проверка ещё не запускалась.")).toBeVisible();
    await expect(block(app).getByRole("button", { name: "Проверить примеры" })).toHaveCount(0);
  });
});
