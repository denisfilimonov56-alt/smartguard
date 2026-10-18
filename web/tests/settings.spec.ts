import { expect, go, modal, test, toast } from "./fixtures";

/* Раздел «Настройки»: переключатели проверки и ключи доступа внешних систем. */

const tab = (page: import("@playwright/test").Page) => page.locator("#tab-settings");

test("переключатель сохраняется на сервере", async ({ app }) => {
  await go(app, "Настройки");
  const examples = tab(app).getByRole("switch", { name: "Примеры в промпте" });
  const guard = tab(app).getByRole("switch", { name: "Защита от prompt injection" });
  await expect(examples).toHaveAttribute("aria-checked", "false");
  await expect(guard).toHaveAttribute("aria-checked", "true");

  await examples.click();
  await expect(toast(app, "Настройка сохранена")).toBeVisible();
  await expect(examples).toHaveAttribute("aria-checked", "true");

  await app.reload();
  await go(app, "Настройки");
  await expect(tab(app).getByRole("switch", { name: "Примеры в промпте" })).toHaveAttribute("aria-checked", "true");
  await expect(guard).toHaveAttribute("aria-checked", "true");
});

test("число сохраняется, а недопустимое значение откатывается", async ({ app }) => {
  await go(app, "Настройки");
  const rate = tab(app).getByRole("spinbutton", { name: "Лимит проверок" });
  await expect(rate).toHaveValue("600");
  await rate.fill("120");
  await rate.press("Enter");
  await expect(toast(app, "Настройка сохранена")).toBeVisible();

  const perKind = tab(app).getByRole("spinbutton", { name: "Примеров на атрибут" });
  await perKind.fill("0");
  await perKind.blur();
  await expect(perKind).toHaveValue("2");

  await tab(app).getByRole("switch", { name: "Режим обслуживания" }).click();
  await app.reload();
  await go(app, "Настройки");
  await expect(tab(app).getByRole("spinbutton", { name: "Лимит проверок" })).toHaveValue("120");
  await expect(tab(app).getByRole("switch", { name: "Режим обслуживания" })).toHaveAttribute("aria-checked", "true");
  await expect(tab(app).getByRole("switch", { name: "Кэш ответов" })).toHaveAttribute("aria-checked", "true");
});

test("смена настройки делает проверку примеров устаревшей", async ({ app }) => {
  await go(app, /Замечания/);
  await app.locator("#examplesCheck").getByRole("button", { name: "Проверить примеры" }).click();
  await expect(app.locator("#examplesCheck").getByText("Модель подтверждает примеры")).toBeVisible();

  await go(app, "Настройки");
  await tab(app).getByRole("switch", { name: "Примеры в промпте" }).click();
  await expect(toast(app, "Настройка сохранена")).toBeVisible();
  await go(app, /Замечания/);
  await expect(app.locator("#examplesCheck").getByText("Каталог менялся после проверки")).toBeVisible();
});

test("ключ показывается один раз и отзывается", async ({ app }) => {
  await go(app, "Настройки");
  await expect(tab(app).getByText("Ключей нет.")).toBeVisible();

  await tab(app).getByRole("button", { name: "+ Ключ" }).click();
  await modal(app).getByLabel("Название").fill("Кадровая система");
  await modal(app).getByRole("button", { name: "Создать" }).click();

  const fresh = app.locator("#freshKey");
  await expect(fresh).toContainText("Ключ для «Кадровая система» создан");
  const key = await fresh.locator(".key-value").innerText();
  expect(key).toMatch(/^gc_[0-9a-f]{8}_/);
  const row = tab(app).locator('tr[data-key="Кадровая система"]');
  await expect(row).toContainText(key.slice(0, 12) + "…");
  await expect(row).not.toContainText(key);

  await fresh.getByRole("button", { name: "Скрыть" }).click();
  await expect(tab(app)).not.toContainText(key);

  // Второй ключ с тем же названием не заводится: по названию системы различаются в истории.
  await tab(app).getByRole("button", { name: "+ Ключ" }).click();
  await modal(app).getByLabel("Название").fill("кадровая система");
  await modal(app).getByRole("button", { name: "Создать" }).click();
  await expect(app.getByText(/уже есть/).first()).toBeVisible();
  await modal(app).getByRole("button", { name: "Отмена" }).click();

  await row.getByRole("button", { name: "Отозвать" }).click();
  await app.getByRole("dialog").getByRole("button", { name: "Отозвать" }).click();
  await expect(toast(app, "Ключ отозван")).toBeVisible();
  await expect(tab(app).getByText("Ключей нет.")).toBeVisible();
});

test.describe("редактор", () => {
  test.use({ role: "editor" });

  test("раздела «Настройки» не видит", async ({ app }) => {
    await expect(app.getByRole("tab", { name: "Правила" })).toBeVisible();
    await expect(app.getByRole("tab", { name: "Настройки" })).toHaveCount(0);
  });
});
