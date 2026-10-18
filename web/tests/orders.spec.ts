import {
  choose, clauseBlock, expect, go, menu, modal, orderDoc, orderItem, panel, ruleCard, test, toast, TRAINING,
} from "./fixtures";

/* Раздел «Приказы»: приказ как документ. Сценарии, на которых прежний
   интерфейс уже ломался или которые легко сломать при переделке. */

test("приказ, пункт и правило без бизнес-ключей видны и открываются", async ({ app }) => {
  await go(app, "Приказы");
  await orderItem(app, "ПР-02").click();
  await expect(orderDoc(app).getByText("нет orderId")).toBeVisible();
  await expect(clauseBlock(app, "3.1").getByText("нет clauseId")).toBeVisible();
  const card = ruleCard(app, TRAINING);
  await expect(card.getByText("нет ruleId")).toBeVisible();
  await card.click();
  await expect(panel(app)).toContainText("Приказ ПР-02, пункт 3.1");
  await expect(panel(app).getByText("нет ruleId")).toBeVisible();
  await expect(card).toHaveAttribute("aria-current", "true");
});

test("карточка правила показывает область действия", async ({ app }) => {
  await go(app, "Приказы");
  await expect(ruleCard(app, "упоминание проекта")).toContainText("Только: УЦТ, АГД");
  const deadline = ruleCard(app, "конкретный срок");
  await expect(deadline).toContainText("Все подразделения");
  await expect(clauseBlock(app, "2.4")).toContainText("ссылается на:");
});

test("поиск по приказам", async ({ app }) => {
  await go(app, "Приказы");
  const search = app.getByPlaceholder("Поиск по приказам…");
  await search.fill("мониторинга");
  await expect(orderItem(app, "ПР-01")).toBeVisible();
  await expect(orderItem(app, "ПР-02")).toHaveCount(0);
  await search.fill("такого точно нет");
  await expect(app.locator("#tab-orders").getByText("Ничего не найдено.").first()).toBeVisible();
});

test("редактор произвольных свойств", async ({ app }) => {
  await go(app, "Приказы");
  await menu(orderDoc(app), "Свойства");
  await modal(app).getByRole("button", { name: "+ Свойство" }).click();
  const row = modal(app).locator(".prop-row").last();
  await row.getByLabel("Имя свойства").fill("priority");
  await choose(row.getByLabel("Тип свойства"), "число");
  await row.getByLabel("Значение свойства").fill("3");
  await modal(app).getByRole("button", { name: "Сохранить" }).click();
  await expect(toast(app, "Свойства сохранены")).toBeVisible();

  await menu(orderDoc(app), "Свойства");
  const saved = modal(app).locator('.prop-row[data-prop="priority"]');
  await expect(saved.getByLabel("Тип свойства")).toHaveAttribute("data-value", "number");
  await expect(saved.getByLabel("Значение свойства")).toHaveValue("3");
  await saved.getByTitle("Удалить свойство").click();
  await modal(app).getByRole("button", { name: "Сохранить" }).click();
  await expect(modal(app).locator(".modal")).toHaveCount(0);

  await menu(orderDoc(app), "Свойства");
  await expect(modal(app).locator('.prop-row[data-prop="priority"]')).toHaveCount(0);
  await expect(modal(app).locator('.prop-row[data-prop="date"] .select')).toHaveText("дата");
});

test("правка ключа проверяет уникальность", async ({ app }) => {
  await go(app, "Приказы");
  await menu(clauseBlock(app, "1.1"), "Изменить");
  const key = modal(app).getByLabel("Идентификатор (clauseId)");
  await key.fill("PR-01/2.4");
  await modal(app).getByRole("button", { name: "Сохранить" }).click();
  await expect(toast(app, "уже занят")).toBeVisible();
  await key.fill("PR-01/1.1-new");
  await modal(app).getByRole("button", { name: "Сохранить" }).click();
  await expect(toast(app, "Пункт обновлён")).toBeVisible();
});

test("перенос пункта в другой приказ", async ({ app }) => {
  await go(app, "Приказы");
  await orderItem(app, "ПР-02").click();
  await menu(clauseBlock(app, "3.1"), "Перенести");
  await choose(modal(app).getByLabel("Приказ", { exact: true }), "ПР-01");
  await modal(app).getByRole("button", { name: "Сохранить" }).click();
  await expect(toast(app, "Пункт перенесён")).toBeVisible();
  await expect(orderItem(app, "ПР-01")).toContainText("3 п. · 3 прав.");
  await expect(orderItem(app, "ПР-02")).toContainText("1 п. · 1 прав.");
});

test("удаление активного пункта без предварительного архивирования", async ({ app }) => {
  await go(app, "Приказы");
  await menu(clauseBlock(app, "2.4"), "Удалить");
  const dialog = app.getByRole("dialog");
  await expect(dialog).toContainText("вместе с 1 правил(а), 1 пример(ов)");
  await dialog.getByRole("button", { name: "Удалить" }).click();
  await expect(toast(app, "Удалено")).toBeVisible();
  await expect(clauseBlock(app, "2.4")).toHaveCount(0);
  await expect(orderItem(app, "ПР-01")).toContainText("1 п. · 1 прав.");
});

test("новый пункт и архив приказа", async ({ app }) => {
  await go(app, "Приказы");
  await orderDoc(app).getByRole("button", { name: "+ Добавить пункт" }).click();
  await modal(app).getByLabel("Номер пункта").fill("5.1");
  await modal(app).getByLabel("Текст пункта").fill("Новый пункт приказа");
  await modal(app).getByRole("button", { name: "Создать" }).click();
  await expect(clauseBlock(app, "5.1")).toContainText("Правил нет — пункт ничего не проверяет.");

  await menu(orderDoc(app), "В архив");
  await expect(orderItem(app, "ПР-01")).toHaveCount(0);
  await app.locator("#tab-orders").getByLabel("Архив").check();
  await orderItem(app, "ПР-01").click();
  await expect(orderDoc(app).getByText("в архиве").first()).toBeVisible();
});

test("ввод экранируется, а не исполняется как HTML", async ({ app }) => {
  await go(app, "Приказы");
  await app.getByRole("button", { name: "+ Добавить приказ" }).click();
  await modal(app).getByLabel("Номер").fill("ПР-99");
  await modal(app).getByLabel("Заголовок").fill("<b>жирный</b><img src=x onerror=\"window.__xss=1\">");
  await modal(app).getByRole("button", { name: "Создать" }).click();
  // Созданный приказ сразу открыт.
  const title = orderDoc(app).locator("h1");
  await expect(title).toContainText("ПР-99 · <b>жирный</b>");
  await expect(title.locator("b")).toHaveCount(0);
  await expect(orderDoc(app).locator("img")).toHaveCount(0);
  expect(await app.evaluate(() => (window as { __xss?: number }).__xss)).toBeUndefined();
});

test("меню действий: одно на экране, шире кнопки, закрывается", async ({ app }) => {
  await go(app, "Приказы");
  // Меню пункта открывается под кнопкой и не перекрывает кнопку приказа выше.
  await clauseBlock(app, "2.4").getByRole("button", { name: "Действия" }).click();
  const button = orderDoc(app).getByRole("button", { name: "Действия" }).first();
  await button.click();
  const popup = app.getByRole("menu");
  await expect(popup).toHaveCount(1);
  await expect(popup.getByRole("menuitem")).toHaveText(["Изменить", "Создать пункт", "Свойства", "В архив", "Удалить"]);
  const [menuBox, buttonBox] = [await popup.boundingBox(), await button.boundingBox()];
  expect(menuBox!.width).toBeGreaterThan(buttonBox!.width);

  await app.keyboard.press("Escape");
  await expect(popup).toBeHidden();
  await button.click();
  await app.locator(".side .brand").click();
  await expect(popup).toBeHidden();
});

test("пустое обязательное поле не отправляется", async ({ app }) => {
  await go(app, "Приказы");
  await app.getByRole("button", { name: "+ Добавить приказ" }).click();
  await modal(app).getByRole("button", { name: "Создать" }).click();
  await expect(toast(app, "Заполните поле «Номер»")).toBeVisible();
});
