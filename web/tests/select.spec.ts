import { clauseBlock, expect, go, menu, modal, selectMenu, test } from "./fixtures";

/* Выпадающий список (ui/Select.tsx) — собственный, а не системный. */

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
  const field = modal(app).getByLabel("Приказ");
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
