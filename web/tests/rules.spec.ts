import {
  cell, choose, clauseBlock, DEADLINE, expect, go, matrixRow, menu, modal, openRule, panel, PROJECT,
  test, toast, TRAINING,
} from "./fixtures";

/* Матрица «правила × подразделения», панель правила и мастер. */

test("матрица показывает состояние каждой ячейки", async ({ app }) => {
  await go(app, "Правила");
  await expect(cell(app, PROJECT, "УЦТ")).toHaveAttribute("data-state", "applies");
  await expect(cell(app, PROJECT, "Финансовое управление")).toHaveAttribute("data-state", "off");
  await expect(cell(app, DEADLINE, "АГД")).toHaveAttribute("data-state", "applies");
  await expect(cell(app, TRAINING, "АГД")).toHaveAttribute("data-state", "applies");
  // У ячейки два состояния: исключений нет.
  await cell(app, DEADLINE, "АГД").click();
  await expect(modal(app).getByRole("radio")).toHaveCount(2);
  await expect(modal(app).getByRole("radio", { name: /Исключение/ })).toHaveCount(0);
});

test("«не действует» ограничивает правило остальными подразделениями", async ({ app }) => {
  await go(app, "Правила");
  const save = modal(app).getByRole("button", { name: "Сохранить" });
  const off = modal(app).getByRole("radio", { name: /Не действует/ });

  await cell(app, TRAINING, "УЦТ").click();
  await off.click();
  await save.click();
  await expect(cell(app, TRAINING, "УЦТ")).toHaveAttribute("data-state", "off");
  await expect(cell(app, TRAINING, "АГД")).toHaveAttribute("data-state", "applies");

  await cell(app, TRAINING, "АГД").click();
  await off.click();
  await save.click();
  await expect(cell(app, TRAINING, "АГД")).toHaveAttribute("data-state", "off");

  // Последнее подразделение отключить нельзя: пустой список означал бы «для всех».
  await cell(app, TRAINING, "Финансовое управление").click();
  await off.click();
  await save.click();
  await expect(toast(app, "хотя бы в одном подразделении")).toBeVisible();
});

test("ячейку «не действует» можно вернуть в «действует»", async ({ app }) => {
  await go(app, "Правила");
  await cell(app, PROJECT, "Финансовое управление").click();
  await modal(app).getByRole("radio", { name: "Правило действует" }).click();
  await modal(app).getByRole("button", { name: "Сохранить" }).click();
  await expect(cell(app, PROJECT, "Финансовое управление")).toHaveAttribute("data-state", "applies");
});

test("поиск и фильтр по приказу в матрице", async ({ app }) => {
  await go(app, "Правила");
  await app.getByPlaceholder("Поиск по правилам…").fill("мониторинга");
  await expect(matrixRow(app, DEADLINE)).toBeVisible();
  await expect(matrixRow(app, PROJECT)).toHaveCount(0);
  await app.getByPlaceholder("Поиск по правилам…").fill("");
  await choose(app.locator("#tab-rules").getByLabel("Приказ"), "ПР-02");
  await expect(matrixRow(app, TRAINING)).toBeVisible();
  await expect(matrixRow(app, DEADLINE)).toHaveCount(0);
});

test("панель правила собирает всё в одном месте", async ({ app }) => {
  await openRule(app, DEADLINE);
  const p = panel(app);
  await expect(p).toContainText("Приказ ПР-01, пункт 2.4");
  await expect(p).toContainText("срок_исполнения");
  await expect(p).toContainText("в цели указан проверяемый срок");
  await expect(p.getByRole("button", { name: "Все подразделения" })).toHaveAttribute("aria-pressed", "true");
  await expect(p).not.toContainText("Исключени");
  await expect(p.locator(".example")).toContainText("Внедрить систему мониторинга");
  await p.getByLabel("Закрыть панель").click();
  await expect(p).toHaveCount(0);
});

test("панель: «только выбранные» и возврат ко всем", async ({ app }) => {
  await openRule(app, TRAINING);
  const p = panel(app);
  await p.getByRole("button", { name: "Только выбранные" }).click();
  await p.locator(".box", { hasText: "УЦТ" }).click();
  await expect(cell(app, TRAINING, "АГД")).toHaveAttribute("data-state", "off");
  await expect(cell(app, TRAINING, "УЦТ")).toHaveAttribute("data-state", "applies");

  await p.locator(".box", { hasText: "УЦТ" }).click();
  await expect(toast(app, "хотя бы одно подразделение")).toBeVisible();

  await p.getByRole("button", { name: "Все подразделения" }).click();
  await expect(cell(app, TRAINING, "АГД")).toHaveAttribute("data-state", "applies");
});

test("панель: атрибут без описания описывается на месте", async ({ app }) => {
  await openRule(app, TRAINING);
  const alert = panel(app).locator(".alert");
  await expect(alert).toContainText("Нет описания");
  await alert.getByRole("button", { name: "Описать" }).click();
  await modal(app).getByLabel("Описание для модели").fill("цель состоит только в прохождении обучения или курса");
  await modal(app).getByRole("button", { name: "Сохранить" }).click();
  await expect(alert).toHaveCount(0);
  await expect(panel(app)).toContainText("цель состоит только в прохождении обучения");
  await expect(app.getByRole("tab", { name: /Замечания/ }).locator(".n")).toHaveText("1");
});

test("панель: полный цикл по примерам", async ({ app }) => {
  await openRule(app, PROJECT);
  const p = panel(app);
  await p.getByRole("button", { name: "+ Добавить пример" }).click();
  await modal(app).getByLabel("Формулировка", { exact: true }).fill("В рамках проекта «Гамма» до 01.12.2025");
  await modal(app).getByRole("button", { name: "Добавить" }).click();
  await expect(toast(app, "Пример добавлен")).toBeVisible();
  const example = p.locator(".example").filter({ hasText: "«Гамма»" });

  await menu(example, "Изменить");
  await modal(app).getByLabel("Формулировка", { exact: true }).fill("В рамках проекта «Дельта» до 01.12.2025");
  await modal(app).getByRole("button", { name: "Сохранить" }).click();
  const edited = p.locator(".example").filter({ hasText: "«Дельта»" });
  await expect(edited).toBeVisible();

  await menu(edited, "В архив");
  await expect(edited).toHaveCount(0);
  await app.locator("#tab-rules").getByLabel("Архив").check();
  await expect(edited.getByText("в архиве")).toBeVisible();
  await menu(edited, "Вернуть");
  await expect(edited.getByText("в архиве")).toHaveCount(0);

  await menu(edited, "Удалить");
  await modal(app).getByRole("button", { name: "Удалить" }).click();
  await expect(toast(app, "Пример удалён")).toBeVisible();
  await expect(edited).toHaveCount(0);
});

test("мастер: новое правило от пункта до примеров", async ({ app }) => {
  await go(app, "Правила");
  const w = app.locator("#tab-rules");
  await w.getByRole("button", { name: "+ Правило" }).click();
  await expect(w.getByRole("heading", { name: "Новое правило" })).toBeVisible();

  // Шаг 1: новый пункт в ПР-01
  await w.getByRole("button", { name: "Новый пункт" }).click();
  await w.getByLabel("Номер пункта").fill("4.1");
  await w.getByLabel("Текст пункта").fill("В цели должен быть назван ответственный");
  await w.getByRole("button", { name: /Далее/ }).click();

  // Шаг 2: что проверяем — существующий атрибут и новый
  await w.getByLabel("Формулировка правила").fill("Цель обязана называть ответственного");
  await w.getByLabel("Что подсказать автору цели").fill("Укажите должность или фамилию ответственного");
  await w.locator(".box", { hasText: "проект" }).click();
  await w.getByLabel("Или новый атрибут").fill("ответственный");
  await w.getByLabel("Описание нового атрибута").fill("в цели названа должность или фамилия ответственного");
  await w.getByRole("button", { name: /Далее/ }).click();

  // Шаг 3: где действует
  await w.getByRole("radio", { name: /Только в выбранных/ }).click();
  await w.locator(".box", { hasText: "АГД" }).click();
  await w.locator(".box", { hasText: "УЦТ" }).click();
  await expect(w.getByRole("button", { name: "+ Добавить исключение" })).toHaveCount(0);
  await w.getByRole("button", { name: /Далее/ }).click();

  // Шаг 4: пример и предпросмотр
  await w.getByLabel("Формулировка цели").fill("Ответственный — руководитель группы: сдать отчёт до 01.03.2026");
  await w.getByRole("button", { name: "Добавить пример" }).click();
  await expect(w.locator(".preview")).toContainText("Цель обязана называть ответственного");
  await expect(w.locator(".preview")).toContainText("Приказ ПР-01, пункт 4.1");
  await expect(w.locator(".preview")).toContainText("Ответственный — руководитель группы");
  await w.getByRole("button", { name: "Создать правило" }).click();
  await expect(toast(app, "Правило создано")).toBeVisible();

  // Правило открыто в панели и стоит в матрице
  const p = panel(app);
  await expect(p).toContainText("Приказ ПР-01, пункт 4.1");
  await expect(p).toContainText("в цели названа должность или фамилия ответственного");
  await expect(p.locator(".example")).toContainText("руководитель группы");
  await expect(cell(app, "называть ответственного", "УЦТ")).toHaveAttribute("data-state", "applies");
  await expect(cell(app, "называть ответственного", "АГД")).toHaveAttribute("data-state", "applies");
  await expect(cell(app, "называть ответственного", "Финансовое управление")).toHaveAttribute("data-state", "off");
});

test("мастер не пускает дальше с незаполненным шагом", async ({ app }) => {
  await go(app, "Правила");
  const w = app.locator("#tab-rules");
  await w.getByRole("button", { name: "+ Правило" }).click();
  await w.getByRole("button", { name: /Далее/ }).click();
  await w.getByRole("button", { name: /Далее/ }).click();
  await expect(toast(app, "Сформулируйте правило")).toBeVisible();
  await w.getByLabel("Формулировка правила").fill("Новое правило");
  await w.getByRole("button", { name: /Далее/ }).click();
  await expect(toast(app, "Выберите хотя бы один атрибут")).toBeVisible();
  await w.getByLabel("Или новый атрибут").fill("срок исполнения");
  await w.getByRole("button", { name: /Далее/ }).click();
  await expect(toast(app, "Опишите новый атрибут")).toBeVisible();

  await w.getByRole("button", { name: "Отмена" }).first().click();
  await expect(w.getByRole("heading", { name: "Где какое правило действует" })).toBeVisible();
});

test("мастер из пункта приказа начинается с шага «Что проверяем»", async ({ app }) => {
  await go(app, "Приказы");
  await clauseBlock(app, "2.4").getByRole("button", { name: "+ Правило" }).click();
  const w = app.locator("#tab-rules");
  await expect(w.getByRole("button", { name: /Что проверяем/ })).toHaveAttribute("aria-current", "step");
  await expect(w.locator(".sumline").first()).toContainText("2.4 — Цель должна иметь конкретные сроки исполнения");
});
