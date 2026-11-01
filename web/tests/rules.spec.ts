import {
  apiHeaders, cell, choose, clauseBlock, DEADLINE, expect, go, matrixRow, menu, modal, openRule, panel, PROJECT,
  test, toast, TRAINING,
} from "./fixtures";

/* Матрица «правила × подразделения», панель правила и мастер. */

test("матрица показывает состояние каждой ячейки", async ({ app }) => {
  await go(app, "Правила");
  await expect(cell(app, PROJECT, "УЦТ")).toHaveAttribute("data-state", "applies");
  await expect(cell(app, PROJECT, "Финансовое управление")).toHaveAttribute("data-state", "off");
  await expect(cell(app, DEADLINE, "АГД")).toHaveAttribute("data-state", "applies");
  await expect(cell(app, TRAINING, "АГД")).toHaveAttribute("data-state", "applies");
});

test("щелчок по ячейке «не действует» ограничивает правило остальными подразделениями", async ({ app }) => {
  await go(app, "Правила");
  // Без окна выбора: щелчок сразу переключает.
  await cell(app, TRAINING, "УЦТ").click();
  await expect(cell(app, TRAINING, "УЦТ")).toHaveAttribute("data-state", "off");
  await expect(cell(app, TRAINING, "АГД")).toHaveAttribute("data-state", "applies");
  await expect(modal(app).getByRole("dialog")).toHaveCount(0);
  // Правило было «для всех»: уведомление предупреждает о новых подразделениях.
  await expect(toast(app, "больше не действует для «УЦТ»")).toContainText("заведённые позже");

  await cell(app, TRAINING, "АГД").click();
  await expect(cell(app, TRAINING, "АГД")).toHaveAttribute("data-state", "off");

  // Последнее подразделение отключить нельзя: пустой список означал бы «для всех».
  await cell(app, TRAINING, "Финансовое управление").click();
  await expect(toast(app, "хотя бы в одном подразделении")).toBeVisible();
  await expect(cell(app, TRAINING, "Финансовое управление")).toHaveAttribute("data-state", "applies");
});

test("ячейку «не действует» можно вернуть щелчком, а ошибочный щелчок — отменить", async ({ app }) => {
  await go(app, "Правила");
  await cell(app, PROJECT, "Финансовое управление").click();
  await expect(cell(app, PROJECT, "Финансовое управление")).toHaveAttribute("data-state", "applies");
  await toast(app, "теперь действует для «Финансовое управление»").getByRole("button", { name: "Отменить" }).click();
  await expect(cell(app, PROJECT, "Финансовое управление")).toHaveAttribute("data-state", "off");
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

test("панель: быстрые отметки «где действует» не затирают друг друга", async ({ app }) => {
  await openRule(app, TRAINING);
  const p = panel(app);
  await p.getByRole("button", { name: "Только выбранные" }).click();
  await p.locator(".box", { hasText: "УЦТ" }).click();
  // Следующая отметка — только после сохранения предыдущей: флажки на это время заблокированы.
  await p.locator(".box", { hasText: "АГД" }).click();
  await expect(cell(app, TRAINING, "УЦТ")).toHaveAttribute("data-state", "applies");
  await expect(cell(app, TRAINING, "АГД")).toHaveAttribute("data-state", "applies");
  await expect(cell(app, TRAINING, "Финансовое управление")).toHaveAttribute("data-state", "off");
  await expect(p.locator(".box", { hasText: "УЦТ" }).locator("input")).toBeChecked();
});

test("панель: сохранённая область действия не откатывается на флажках, если перечитать каталог не удалось", async ({ app }) => {
  await openRule(app, TRAINING);
  const p = panel(app);
  await p.getByRole("button", { name: "Только выбранные" }).click();
  // После сохранения каталог не перечитывается: на экране остались бы старые данные.
  await app.route("**/api/catalog/tree*", (route) => route.fulfill({ status: 500, contentType: "application/json", body: "{}" }));
  await p.locator(".box", { hasText: "УЦТ" }).click();
  await expect(toast(app, "Область действия обновлена")).toBeVisible();
  await expect(toast(app, "Не удалось получить данные")).toBeVisible();
  await expect(p.locator(".box", { hasText: "УЦТ" }).locator("input")).toBeChecked();
  // Следующая отметка строится от отправленного списка, а не от старых данных.
  await p.locator(".box", { hasText: "АГД" }).click();
  await expect(p.locator(".box", { hasText: "АГД" }).locator("input")).toBeChecked();
  await expect(p.locator(".box", { hasText: "УЦТ" }).locator("input")).toBeChecked();
  await app.unroute("**/api/catalog/tree*");
  await app.getByRole("button", { name: "Меню пользователя" }).click();
  await app.getByRole("menuitem", { name: "Обновить" }).click();
  await expect(cell(app, TRAINING, "УЦТ")).toHaveAttribute("data-state", "applies");
  await expect(cell(app, TRAINING, "АГД")).toHaveAttribute("data-state", "applies");
  await expect(cell(app, TRAINING, "Финансовое управление")).toHaveAttribute("data-state", "off");
});

test("панель: «только для студентов» и обратно", async ({ app }) => {
  await openRule(app, DEADLINE);
  const p = panel(app);
  const group = p.getByRole("group", { name: "Для кого" });
  await expect(group.getByRole("button", { name: "Для всех" })).toHaveAttribute("aria-pressed", "true");
  await expect(matrixRow(app, DEADLINE)).not.toContainText("только студенты");

  await group.getByRole("button", { name: "Только для студентов" }).click();
  await expect(toast(app, "Правило теперь только для студентов")).toBeVisible();
  await expect(group.getByRole("button", { name: "Только для студентов" })).toHaveAttribute("aria-pressed", "true");
  await expect(p).toContainText("Проверяется, только если в запросе проверки передано");
  await expect(matrixRow(app, DEADLINE)).toContainText("только студенты");

  await group.getByRole("button", { name: "Для всех" }).click();
  await expect(toast(app, "Правило теперь для всех")).toBeVisible();
  await expect(matrixRow(app, DEADLINE)).not.toContainText("только студенты");
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
  // Под листом страница затемнена: чтобы включить архив, лист закрывается и открывается снова.
  await app.keyboard.press("Escape");
  await app.locator("#tab-rules").getByLabel("Архив").check();
  await openRule(app, PROJECT);
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

test("мастер: пункт и атрибут прошлой попытки, от которых отказались, убираются с подтверждением", async ({ app }) => {
  await go(app, "Правила");
  const w = app.locator("#tab-rules");
  await w.getByRole("button", { name: "+ Правило" }).click();
  await w.getByRole("button", { name: "Новый пункт" }).click();
  await w.getByLabel("Номер пункта").fill("9.9");
  await w.getByLabel("Текст пункта").fill("Пункт-сирота");
  await w.getByRole("button", { name: /Далее/ }).click();
  await w.getByLabel("Формулировка правила").fill("Правило после сбоя");
  await w.getByLabel("Или новый атрибут").fill("сирота_атрибут");
  await w.getByLabel("Описание нового атрибута").fill("атрибут, от которого потом отказались");
  await w.getByRole("button", { name: /Далее/ }).click();
  await w.getByRole("button", { name: /Далее/ }).click();

  // Первая попытка: пункт и атрибут созданы, правило — нет.
  let failed = false;
  await app.route("**/api/catalog/rules", (route) => {
    if (failed || route.request().method() !== "POST") return route.fallback();
    failed = true;
    return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "Сбой записи" }) });
  });
  await w.getByRole("button", { name: "Создать правило" }).click();
  await expect(toast(app, "Сбой записи")).toBeVisible();

  // Передумали: существующий пункт и существующий атрибут.
  await w.getByRole("button", { name: "Пункт приказа" }).click();
  await w.getByRole("button", { name: "Существующий пункт" }).click();
  await w.getByRole("button", { name: /Что проверяем/ }).click();
  await w.getByLabel("Или новый атрибут").fill("");
  await w.getByLabel("Описание нового атрибута").fill("");
  await w.locator(".box", { hasText: "проект" }).click();
  await w.getByRole("button", { name: /Примеры/ }).click();
  await w.getByRole("button", { name: "Создать правило" }).click();

  const ask = modal(app).getByRole("dialog");
  await expect(ask).toContainText("пункт 9.9");
  await expect(ask).toContainText("атрибут «сирота_атрибут»");
  await ask.getByRole("button", { name: "Удалить" }).click();
  await expect(toast(app, "Правило создано")).toBeVisible();

  await go(app, "Атрибуты");
  await expect(app.locator("#tab-targets")).not.toContainText("сирота_атрибут");
  await go(app, "Приказы");
  await expect(app.locator("#tab-orders")).not.toContainText("Пункт-сирота");
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

  // Введённое не сохранено: «Отмена» сначала переспрашивает.
  await w.getByRole("button", { name: "Отмена" }).first().click();
  const ask = modal(app).getByRole("dialog", { name: "Закрыть мастер правила?" });
  await ask.getByRole("button", { name: "Отмена" }).click();
  await expect(w.getByLabel("Формулировка правила")).toHaveValue("Новое правило");
  await w.getByRole("button", { name: "Отмена" }).first().click();
  await ask.getByRole("button", { name: "Закрыть" }).click();
  await expect(w.getByRole("heading", { name: "Где какое правило действует" })).toBeVisible();
});

test("мастер из пункта приказа начинается с шага «Что проверяем»", async ({ app }) => {
  await go(app, "Приказы");
  await clauseBlock(app, "2.4").getByRole("button", { name: "+ Правило" }).click();
  const w = app.locator("#tab-rules");
  await expect(w.getByRole("button", { name: /Что проверяем/ })).toHaveAttribute("aria-current", "step");
  await expect(w.locator(".sumline").first()).toContainText("2.4 — Цель должна иметь конкретные сроки исполнения");
});

test("мастер: переход в другой раздел и обучение не теряют ввод молча; тот же раздел мастер не закрывает", async ({ app }) => {
  await go(app, "Правила");
  const w = app.locator("#tab-rules");
  await w.getByRole("button", { name: "+ Правило" }).click();
  await w.getByRole("button", { name: /Далее/ }).click();
  await w.getByLabel("Формулировка правила").fill("Черновик правила");

  // Щелчок по тому же разделу — мастер на месте.
  await go(app, "Правила");
  await expect(w.getByLabel("Формулировка правила")).toHaveValue("Черновик правила");

  // Другой раздел — вопрос; «Отмена» оставляет в мастере.
  await go(app, "Приказы");
  const ask = modal(app).getByRole("dialog", { name: "Закрыть мастер правила?" });
  await ask.getByRole("button", { name: "Отмена" }).click();
  await expect(w.getByLabel("Формулировка правила")).toHaveValue("Черновик правила");
  expect(new URL(app.url()).pathname).toBe("/rules");

  // Обучение тоже сначала спрашивает.
  await app.getByRole("button", { name: "Меню пользователя" }).click();
  await app.getByRole("menuitem", { name: "Обучение" }).click();
  await ask.getByRole("button", { name: "Отмена" }).click();
  await expect(app.locator(".tour-card")).toHaveCount(0);
  await expect(w.getByLabel("Формулировка правила")).toHaveValue("Черновик правила");

  // Согласились закрыть — переход состоялся.
  await go(app, "Приказы");
  await ask.getByRole("button", { name: "Закрыть" }).click();
  await expect(app.locator("#tab-orders")).toBeVisible();
});

test("мастер: при закрытии предлагает убрать правило и пункт, созданные неудачной попыткой", async ({ app }) => {
  await go(app, "Правила");
  const w = app.locator("#tab-rules");
  await w.getByRole("button", { name: "+ Правило" }).click();
  await w.getByRole("button", { name: "Новый пункт" }).click();
  await w.getByLabel("Номер пункта").fill("8.8");
  await w.getByLabel("Текст пункта").fill("Пункт недоделанного правила");
  await w.getByRole("button", { name: /Далее/ }).click();
  await w.getByLabel("Формулировка правила").fill("Недоделанное правило");
  await w.locator(".box", { hasText: "проект" }).click();
  await w.getByRole("button", { name: /Далее/ }).click();
  await w.getByRole("button", { name: /Далее/ }).click();
  await w.getByLabel("Формулировка цели").fill("Пример, который не сохранится");
  await w.getByRole("button", { name: "Добавить пример" }).click();
  // Пункт и правило созданы, пример — нет.
  await app.route("**/api/catalog/examples", (route) => route.request().method() === "POST"
    ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "Сбой записи" }) })
    : route.fallback());
  await w.getByRole("button", { name: "Создать правило" }).click();
  await expect(toast(app, "Сбой записи")).toBeVisible();

  await go(app, "Приказы");
  await modal(app).getByRole("dialog", { name: "Закрыть мастер правила?" }).getByRole("button", { name: "Закрыть" }).click();
  const drop = modal(app).getByRole("dialog", { name: "Убрать созданное прошлой попыткой?" });
  await expect(drop).toContainText("правило, пункт 8.8");
  await drop.getByRole("button", { name: "Удалить" }).click();
  await expect(app.locator("#tab-orders")).toBeVisible();
  await expect(app.locator("#tab-orders")).not.toContainText("Пункт недоделанного правила");
  await go(app, "Правила");
  await expect(app.locator("#tab-rules")).not.toContainText("Недоделанное правило");
});

test("форма «Изменить» шлёт только изменённые поля и прежние значения; чужая правка — 409 и перечитывание", async ({ app }) => {
  await openRule(app, DEADLINE);
  const p = panel(app);
  await p.getByRole("button", { name: "Изменить" }).first().click();
  const form = modal(app).getByRole("dialog", { name: /Правило/ });
  await form.getByLabel("Формулировка правила").fill("Цель обязана содержать конкретный срок исполнения (дата)");
  const [request] = await Promise.all([
    app.waitForRequest((r) => r.url().includes("/properties") && r.method() === "PATCH"),
    form.getByRole("button", { name: "Сохранить" }).click(),
  ]);
  expect(request.postDataJSON()).toEqual({
    properties: { description: "Цель обязана содержать конкретный срок исполнения (дата)" },
    expected: { description: "Цель обязана содержать конкретный срок исполнения" },
  });
  await expect(toast(app, "Правило обновлено")).toBeVisible();

  // Форма открыта, а другой редактор тем временем изменил формулировку.
  await p.getByRole("button", { name: "Изменить" }).first().click();
  await form.getByLabel("Что подсказать автору цели").fill("Подсказка A");
  await form.getByLabel("Формулировка правила").fill("Версия A");
  await app.evaluate((headers) => fetch("/api/catalog/nodes/r:2/properties", { method: "PATCH", headers,
    body: JSON.stringify({ properties: { description: "Версия B" } }) }), apiHeaders());
  await form.getByRole("button", { name: "Сохранить" }).click();
  await expect(toast(app, "эти данные изменил другой пользователь")).toBeVisible();
  await expect(form).toHaveCount(0);
  await expect(p.getByRole("heading", { name: "Версия B" })).toBeVisible();
});

test("ячейка матрицы из старого снимка не затирает чужую область действия (409)", async ({ app }) => {
  await go(app, "Правила");
  // Другой редактор ограничил правило одним УЦТ — у нас на экране ещё «для всех».
  await app.evaluate((headers) => fetch("/api/catalog/rules/r:3/departments", { method: "PUT", headers,
    body: JSON.stringify({ only: ["UCT"] }) }), apiHeaders());
  const [request] = await Promise.all([
    app.waitForRequest((r) => r.url().endsWith("/departments") && r.method() === "PUT"),
    (async () => {
      await cell(app, TRAINING, "АГД").click();
    })(),
  ]);
  expect(request.postDataJSON()).toMatchObject({ expected: [] });
  await expect(toast(app, "эти данные изменил другой пользователь")).toBeVisible();
  // Каталог перечитан: видно ограничение другого редактора, оно не потеряно.
  await expect(cell(app, TRAINING, "УЦТ")).toHaveAttribute("data-state", "applies");
  await expect(cell(app, TRAINING, "АГД")).toHaveAttribute("data-state", "off");
  await expect(cell(app, TRAINING, "Финансовое управление")).toHaveAttribute("data-state", "off");
});

test("пока сохраняется область действия из панели, «Изменить» и ячейки правила недоступны", async ({ app }) => {
  await openRule(app, TRAINING);
  const p = panel(app);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await app.route("**/api/catalog/rules/*/departments", async (route) => { await held; await route.fallback(); });
  await p.getByRole("button", { name: "Только выбранные" }).click();
  await p.locator(".box", { hasText: "УЦТ" }).click();
  await expect(p.getByRole("button", { name: "Изменить" }).first()).toBeDisabled();
  await expect(cell(app, TRAINING, "АГД")).toBeDisabled();
  await expect(p.getByRole("group", { name: "Для кого" }).getByRole("button", { name: "Только для студентов" })).toBeDisabled();
  release();
  await expect(toast(app, "Область действия обновлена")).toBeVisible();
  await expect(p.getByRole("button", { name: "Изменить" }).first()).toBeEnabled();
  await expect(cell(app, TRAINING, "АГД")).toBeEnabled();
});
