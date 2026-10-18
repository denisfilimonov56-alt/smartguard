import { check, choose, expect, go, modal, test, toast } from "./fixtures";

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
  await expect(tab(app).getByRole("spinbutton", { name: "Кэш должностных инструкций" })).toHaveValue("60");
});

test("предел запросов к модели и резерв действуют сразу и видны в мониторинге", async ({ app }) => {
  await go(app, "Настройки");
  const capacity = tab(app).getByRole("spinbutton", { name: "Предел запросов к модели" });
  const reserve = tab(app).getByRole("spinbutton", { name: "Резерв для ручных проверок" });
  await expect(capacity).toHaveValue("32");
  await expect(reserve).toHaveValue("4");
  await capacity.fill("8");
  await capacity.press("Enter");
  await expect(toast(app, "Настройка сохранена")).toBeVisible();
  await reserve.fill("2");
  await reserve.press("Enter");
  await expect(reserve).toHaveValue("2");

  await go(app, "Мониторинг");
  const monitoring = app.locator("#tab-monitoring");
  await expect(monitoring.getByText("0 из 8")).toBeVisible();
  await expect(monitoring.getByText("2 слотов оставлено ручным проверкам")).toBeVisible();

  // Резерв не больше предела минус один: сервер обрезает его при чтении.
  await go(app, "Настройки");
  await tab(app).getByRole("spinbutton", { name: "Предел запросов к модели" }).fill("2");
  await tab(app).getByRole("spinbutton", { name: "Предел запросов к модели" }).press("Enter");
  await expect(tab(app).getByRole("spinbutton", { name: "Резерв для ручных проверок" })).toHaveValue("1");
  await expect(tab(app).getByRole("spinbutton", { name: "Предел запросов к модели" })).toHaveValue("2");
});

test("поле показывает значение, которое сохранил сервер, даже если оно не изменилось", async ({ app }) => {
  await go(app, "Настройки");
  const capacity = tab(app).getByRole("spinbutton", { name: "Предел запросов к модели" });
  const reserve = tab(app).getByRole("spinbutton", { name: "Резерв для ручных проверок" });
  await capacity.fill("2");
  await capacity.press("Enter");
  await expect(reserve).toHaveValue("1");
  // Сервер обрезает резерв до предела минус один — прежние 1, хотя ввели 5.
  await reserve.fill("5");
  await reserve.press("Enter");
  await expect(toast(app, "Сервер сохранил значение 1 вместо 5")).toBeVisible();
  await expect(reserve).toHaveValue("1");
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

test("кэш проверки очищается по отдельности и по подразделению", async ({ app }) => {
  const goal = "Снизить долю просроченных заявок до 5% к 31.12.2025";
  await check(app, goal, "UCT");
  await expect(app.locator("#checkResult")).toBeVisible();
  await check(app, goal + " в финансовом управлении", "FIN");
  await expect(app.locator("#checkResult")).toBeVisible();

  await go(app, "Настройки");
  const caches = tab(app).locator("#caches");
  const row = (id: string) => caches.locator(`[data-cache=${id}]`);
  await expect(row("results")).toContainText("записей: 2");
  await expect(row("jobDescriptions")).toContainText("записей: 2");
  await expect(row("smart")).toContainText("записей: 2");

  // Только одно подразделение: вторая запись остаётся.
  await choose(tab(app).locator("#cacheDepartment"), "Только для: УЦТ");
  await row("results").getByRole("button", { name: "Очистить: Ответы проверок" }).click();
  await expect(toast(app, "Кэш «Ответы проверок» очищен для «УЦТ»: записей 1")).toBeVisible();
  await expect(row("results")).toContainText("записей: 1");
  await expect(row("jobDescriptions")).toContainText("записей: 2");

  // Целиком.
  await choose(tab(app).locator("#cacheDepartment"), "Очистить для всех подразделений");
  await row("jobDescriptions").getByRole("button", { name: "Очистить: Должностные инструкции" }).click();
  await expect(toast(app, "Кэш «Должностные инструкции» очищен: записей 2")).toBeVisible();
  await expect(row("jobDescriptions")).toContainText("записей: 0");

  // Оценки SMART удаляются и из графа — с подтверждением.
  await row("smart").getByRole("button", { name: "Очистить: Оценки по SMART" }).click();
  await modal(app).getByRole("button", { name: "Очистить" }).click();
  await expect(toast(app, "Кэш «Оценки по SMART» очищен: записей 2, оценок в графе: 2")).toBeVisible();
  await expect(row("smart")).toContainText("записей: 0");
  await expect(row("results")).toContainText("записей: 1");
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
