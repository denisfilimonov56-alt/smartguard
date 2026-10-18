import { check, choose, expect, go, isApi, modal, test, toast } from "./fixtures";

const GOAL = "Снизить долю просроченных заявок до 5% к 31.12.2025";

test("ответ проверки объясняет, что не так и как исправить", async ({ app }) => {
  const result = await check(app, GOAL);
  await expect(result.getByText("Нужно доработать")).toBeVisible();
  await expect(result.getByText("не выполнено правил: 1 из 3")).toBeVisible();
  const violation = result.locator(".violation");
  await expect(violation).toContainText("Цель обязана содержать упоминание проекта");
  await expect(violation).toContainText("Приказ ПР-01, пункт 1.1");
  await expect(violation).toContainText("Как исправить:");
  await expect(violation).toContainText("Пример: «В рамках проекта «Альфа»");
  // Найденный атрибут подтверждён цитатой из цели.
  await expect(result.locator(".quote")).toHaveText("«31.12.2025»");
  // Под вердиктом — ответ API как есть; по умолчанию свёрнут.
  await expect(app.locator("#checkJson pre")).toBeHidden();
  await app.locator("#checkJson summary").click();
  expect(JSON.parse(await app.locator("#checkJson pre").innerText())).toMatchObject(
    { goal: GOAL, status: "VIOLATIONS_FOUND", attribute_quotes: { срок_исполнения: "31.12.2025" } });

  // Результат не теряется при переходе между разделами.
  await go(app, "Атрибуты");
  await go(app, "Проверка цели");
  await expect(result.getByText("Нужно доработать")).toBeVisible();
});

test("без подразделения применяются все правила, причина — в заметках", async ({ app }) => {
  const result = await check(app, "Улучшить работу с заявками");
  await expect(result.getByText("подразделение: не определено")).toBeVisible();
  await expect(result.getByText(/Подразделение не передано: применены все правила/)).toBeVisible();
  await expect(result.locator(".violation")).toHaveCount(2);
});

test("правило «только в» не применяется к другому подразделению", async ({ app }) => {
  let result = await check(app, GOAL, "FIN");
  await expect(result.getByText("Нарушений нет")).toBeVisible();
  await expect(result.locator(".chip", { hasText: "Финансовое управление" })).toBeVisible();
  await expect(app.getByText("правил: 2 · не для этого подразделения: 1")).toBeVisible();

  result = await check(app, GOAL, "UCT");
  await expect(result.getByText("Нужно доработать")).toBeVisible();
  await expect(result.locator(".violation")).toContainText("пункт 1.1");
});

test("главный экран показывает, что ждёт решения", async ({ app }) => {
  const todo = app.locator("#tab-check .todo");
  await todo.filter({ hasText: "Замечаний к данным: 2" }).getByRole("button", { name: "Открыть" }).click();
  await expect(app.getByRole("tab", { name: /Замечания/ })).toHaveAttribute("aria-selected", "true");
});

test("пустая цель не отправляется", async ({ app }) => {
  await app.locator("#tab-check").getByRole("button", { name: "Проверить" }).click();
  await expect(toast(app, "Введите формулировку цели")).toBeVisible();
});

test("недоступный API виден в боковой панели", async ({ page }) => {
  // Сессия есть, а каталог не отвечает: интерфейс открыт, но данных нет.
  await page.route(isApi, (route) => new URL(route.request().url()).pathname === "/api/auth/me"
    ? route.fulfill({ json: { login: "admin", role: "admin", displayName: null } })
    : route.abort());
  await page.goto("/");
  await expect(page.locator(".side").getByText("API недоступен")).toBeVisible();
  await expect(toast(page, "Не удалось получить данные")).toBeVisible();
});

test("без связи с сервером формы входа нет — только повтор", async ({ page }) => {
  await page.route(isApi, (route) => route.abort());
  await page.goto("/");
  await expect(page.getByText("Не удалось связаться с сервером")).toBeVisible();
  await expect(page.getByLabel("Пароль")).toHaveCount(0);
});

test("путь проверки показывается на графе", async ({ app }) => {
  const result = await check(app, "Пройти обучение по охране труда до 31.12.2025", "AGD");
  await result.getByRole("button", { name: "Показать на графе" }).click();

  const graph = app.locator("#tab-graph");
  await expect(graph.locator(".node.goal")).toBeVisible();
  // Найденный атрибут, нарушенное правило с его пунктом и приказом, ненайденный обязательный атрибут.
  await expect(graph.locator(".node.traced.ok")).toContainText(["срок_исполнения"]);
  await expect(graph.locator(".node.traced.bad").filter({ hasText: "R-1.1" })).toBeVisible();
  await expect(graph.locator(".node.traced.bad").filter({ hasText: "ПР-01" })).toBeVisible();
  await expect(graph.locator(".edge.trace.missing")).toHaveCount(1);
  await expect(graph.locator("aside")).toContainText("Нарушения: 2");

  await graph.getByRole("button", { name: "Сбросить трассировку" }).click();
  await expect(graph.locator(".node.goal")).toHaveCount(0);
  await expect(graph.locator(".node.traced")).toHaveCount(0);
});

test("несогласие с ответом: советчик предлагает правку графа, редактор её применяет", async ({ app }) => {
  const result = await check(app, GOAL);
  await result.locator(".violation").getByRole("button", { name: "Не согласен" }).click();

  const dialog = modal(app).getByRole("dialog");
  // Атрибут нарушенного правила уже выбран, ожидание — обратное ответу проверки.
  await expect(dialog.locator("#adviceAttribute")).toContainText("проект — сейчас не найден");
  await expect(dialog.locator("#adviceExpected")).toContainText("Должно быть: найден");

  await dialog.getByRole("button", { name: "Предложить правку" }).click();
  await expect(toast(app, "Напишите, почему ответ должен быть другим")).toBeVisible();

  await dialog.getByLabel("Обоснование").fill("заявки ведутся в рамках программы «Сервис»");
  await dialog.getByRole("button", { name: "Предложить правку" }).click();
  const description = dialog.locator("#adviceDescription");
  await expect(description.getByText("проверено: на этой цели атрибут найден")).toBeVisible();
  await expect(description).toContainText("уточнение: заявки ведутся в рамках программы «Сервис»");
  await expect(dialog.locator("#adviceRegression")).toContainText("проверено 2, ни один не сломан");

  await description.getByRole("button", { name: "Применить описание" }).click();
  await expect(toast(app, "Описание атрибута обновлено")).toBeVisible();
  await expect(description.getByText("Описание сохранено")).toBeVisible();

  // Цель — корректный пример требования: атрибут в ней должен быть.
  const examples = dialog.locator("#adviceExamples");
  await expect(examples).toContainText("Цель обязана содержать упоминание проекта — корректный пример");
  await examples.getByRole("button", { name: "Добавить" }).click();
  await expect(examples.getByText("Добавлено")).toBeVisible();

  await dialog.getByRole("button", { name: "Закрыть" }).click();
  await go(app, "Атрибуты");
  await expect(app.locator("#tab-targets")).toContainText("уточнение: заявки ведутся в рамках программы «Сервис»");
});

test("советчик: атрибут выбирается в окне; если модель уже согласна, менять нечего", async ({ app }) => {
  await check(app, GOAL);
  // Блок советчика — между формой и ответом.
  await expect(app.locator("#checkDispute + #checkResult")).toBeVisible();
  await app.locator("#checkDispute").getByRole("button", { name: "Предложить правку графа" }).click();
  const dialog = modal(app).getByRole("dialog");
  await dialog.getByRole("button", { name: "Предложить правку" }).click();
  await expect(toast(app, "Выберите атрибут")).toBeVisible();

  await choose(dialog.locator("#adviceAttribute"), "срок_исполнения — сейчас найден");
  await expect(dialog.locator("#adviceExpected")).toContainText("по фрагменту «31.12.2025». Должно быть: не найден");
  await dialog.getByLabel("Обоснование").fill("это не срок, а отчётная дата");
  await dialog.getByRole("button", { name: "Предложить правку" }).click();
  await expect(dialog.locator("#adviceDescription")).toContainText("на этой цели атрибут не найден");
});

test.describe("читатель", () => {
  test.use({ role: "viewer" });

  test("советчика не видит", async ({ app }) => {
    const result = await check(app, GOAL);
    await expect(result.locator(".violation")).toBeVisible();
    await expect(result.getByRole("button", { name: "Не согласен" })).toHaveCount(0);
    await expect(app.locator("#checkDispute")).toHaveCount(0);
  });
});
