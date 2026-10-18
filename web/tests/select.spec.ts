import { clauseBlock, expect, go, menu, modal, openRule, panel, PROJECT, selectMenu, test } from "./fixtures";

/* Выпадающий список (ui/Select.tsx) — собственный, а не системный. Здесь же —
   клавиатура в остальных всплывающих элементах: меню «⋯», окна, поиск. */

test("список открывается под полем, выбирает мышью и закрывается кликом мимо", async ({ app }) => {
  const field = app.locator("#departmentInput");
  await expect(field).toHaveText("Подразделение не указано");
  await field.click();
  const list = selectMenu(app);
  await expect(list.getByRole("option")).toHaveText(["Подразделение не указано", "АГД", "Финансовое управление", "УЦТ"]);
  await expect(list.getByRole("option", { name: "Подразделение не указано" })).toHaveAttribute("aria-selected", "true");

  // Меню — той же ширины, что поле, и сразу под ним.
  const [fieldBox, listBox] = [await field.boundingBox(), await list.boundingBox()];
  expect(Math.abs(listBox!.x - fieldBox!.x)).toBeLessThan(2);
  expect(Math.abs(listBox!.width - fieldBox!.width)).toBeLessThan(2);
  expect(listBox!.y).toBeGreaterThan(fieldBox!.y + fieldBox!.height);

  await list.getByRole("option", { name: "АГД" }).click();
  await expect(list).toHaveCount(0);
  await expect(field).toHaveText("АГД");
  await expect(field).toHaveAttribute("data-value", "AGD");

  await field.click();
  await app.locator(".side .brand").click();
  await expect(list).toHaveCount(0);
});

test("список управляется с клавиатуры", async ({ app }) => {
  const field = app.locator("#departmentInput");
  await field.focus();
  await field.press("ArrowDown");
  await expect(selectMenu(app)).toBeVisible();
  await field.press("ArrowDown");
  await field.press("ArrowDown");
  await field.press("Enter");
  await expect(field).toHaveText("Финансовое управление");

  await field.press("Enter");
  await field.press("Escape");
  await expect(selectMenu(app)).toHaveCount(0);
  await expect(field).toHaveText("Финансовое управление");
});

test("Escape закрывает список, а не диалог, в котором он открыт", async ({ app }) => {
  await go(app, "Приказы");
  await menu(clauseBlock(app, "1.1"), "Перенести");
  const field = modal(app).getByLabel("Приказ", { exact: true });
  await field.click();
  await expect(selectMenu(app)).toBeVisible();
  await field.press("Escape");
  await expect(selectMenu(app)).toHaveCount(0);
  await expect(modal(app).locator(".modal")).toBeVisible();
  await field.press("Escape");
  await expect(modal(app).locator(".modal")).toHaveCount(0);
});

test("поиск по правилам занимает всю свободную ширину панели", async ({ app }) => {
  await go(app, "Правила");
  const search = await app.getByPlaceholder("Поиск по правилам…").boundingBox();
  const filter = await app.locator("#tab-rules").getByLabel("Приказ").boundingBox();
  expect(search!.width).toBeGreaterThan(filter!.width * 2);
});

test("меню «⋯» управляется с клавиатуры и возвращает фокус на кнопку", async ({ app }) => {
  const button = app.getByRole("button", { name: "Меню пользователя" });
  await button.focus();
  await app.keyboard.press("Enter");
  await expect(app.getByRole("menuitem", { name: "Обновить" })).toBeFocused();
  await app.keyboard.press("ArrowDown");
  await expect(app.getByRole("menuitem", { name: "Обучение" })).toBeFocused();
  await app.keyboard.press("End");
  await expect(app.getByRole("menuitem", { name: "Выйти" })).toBeFocused();
  await app.keyboard.press("ArrowDown");
  await expect(app.getByRole("menuitem", { name: "Обновить" })).toBeFocused();
  await app.keyboard.press("Escape");
  await expect(app.getByRole("menu")).toHaveCount(0);
  await expect(button).toBeFocused();
});

test("Escape закрывает меню в панели правила, а не саму панель", async ({ app }) => {
  await openRule(app, PROJECT);
  await panel(app).getByRole("button", { name: "Действия" }).first().click();
  await expect(app.getByRole("menu")).toBeVisible();
  await app.keyboard.press("Escape");
  await expect(app.getByRole("menu")).toHaveCount(0);
  await expect(panel(app)).toBeVisible();
  await app.keyboard.press("Escape");
  await expect(panel(app)).toHaveCount(0);
});

test("Tab не уходит из окна, а после закрытия фокус возвращается", async ({ app }) => {
  await go(app, "Приказы");
  const actions = clauseBlock(app, "1.1").getByRole("button", { name: "Действия" }).first();
  await menu(clauseBlock(app, "1.1"), "Перенести");
  await expect(modal(app).locator(".modal")).toBeVisible();
  for (let i = 0; i < 8; i++) {
    await app.keyboard.press(i % 3 ? "Tab" : "Shift+Tab");
    expect(await app.evaluate(() => !!document.activeElement?.closest("#modalRoot"))).toBe(true);
  }
  await modal(app).getByRole("button", { name: "Отмена" }).click();
  await expect(modal(app).locator(".modal")).toHaveCount(0);
  await expect(actions).toBeFocused();
});

test("подтверждение по Escape отвечает «нет»", async ({ app }) => {
  await app.getByRole("button", { name: "Меню пользователя" }).click();
  await app.getByRole("menuitem", { name: "Выйти" }).click();
  await expect(app.getByRole("dialog", { name: "Выйти из учётной записи?" })).toBeVisible();
  await app.keyboard.press("Escape");
  await expect(app.getByRole("dialog")).toHaveCount(0);
  await expect(app.locator(".side")).toBeVisible();
  // Повторный вызов работает: прежнее ожидание ответа не зависло.
  await app.getByRole("button", { name: "Меню пользователя" }).click();
  await app.getByRole("menuitem", { name: "Выйти" }).click();
  await app.getByRole("dialog").getByRole("button", { name: "Отмена" }).click();
  await expect(app.locator(".side")).toBeVisible();
});

test("поиск открывается по Ctrl+K и при русской раскладке", async ({ app }) => {
  await app.evaluate(() => dispatchEvent(new KeyboardEvent("keydown", { key: "л", code: "KeyK", ctrlKey: true, bubbles: true })));
  await expect(app.getByRole("dialog", { name: "Быстрый переход" })).toBeVisible();
});
