import { check, choose, expect, go, isApi, mockTokens, modal, test, toast } from "./fixtures";

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

  // Кнопка в заголовке копирует ответ, не сворачивая и не разворачивая блок.
  await app.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await app.locator("#checkJson").getByRole("button", { name: "Скопировать JSON" }).click();
  await expect(toast(app, "JSON скопирован")).toBeVisible();
  await expect(app.locator("#checkJson pre")).toBeVisible();
  expect(JSON.parse(await app.evaluate(() => navigator.clipboard.readText()))).toMatchObject({ goal: GOAL });

  // Результат не теряется при переходе между разделами.
  await go(app, "Атрибуты");
  await go(app, "Проверка цели");
  await expect(result.getByText("Нужно доработать")).toBeVisible();
});

test("после проверки формулировка остаётся в синем блоке, атрибуты открываются по клику", async ({ app }) => {
  const result = await check(app, GOAL);
  // Поле ввода сменилось формулировкой с подсветкой — в том же блоке, что и до проверки.
  const summary = app.locator("#tab-check .hero #goalSummary");
  await expect(summary).toContainText(GOAL);
  await expect(app.locator("#goalInput")).toHaveCount(0);
  await expect(app.locator("#tab-check .hero").getByRole("button", { name: "Проверить" })).toBeVisible();

  // Пять кругов SMART: срок в цели назван, значимость не видна.
  const smart = result.locator("#checkSmart .ring");
  await expect(smart).toHaveCount(5);
  await expect(smart.filter({ hasText: "В срок" })).toHaveClass(/\bok\b/);
  await expect(smart.filter({ hasText: "Значимая" })).toHaveClass(/\bbad\b/);
  await expect(result.getByText("справочно, на вердикт не влияет")).toBeVisible();

  // Подсвеченный фрагмент ведёт к атрибуту в словаре.
  await summary.locator("mark.hl.link", { hasText: "31.12.2025" }).click();
  await expect(app.getByRole("tab", { name: "Атрибуты" })).toHaveAttribute("aria-selected", "true");
  await expect(app.locator("#tab-targets tr.flash")).toContainText("срок_исполнения");

  // Чип атрибута в ответе — тоже ссылка; «Изменить» возвращает поле ввода.
  await go(app, "Проверка цели");
  await result.locator(".chip-btn", { hasText: "срок_исполнения" }).click();
  await expect(app.getByRole("tab", { name: "Атрибуты" })).toHaveAttribute("aria-selected", "true");
  await go(app, "Проверка цели");
  await summary.getByRole("button", { name: "Изменить" }).click();
  await expect(app.locator("#goalInput")).toHaveValue(GOAL);
});

test("после правки формулировки прежний ответ не показывается", async ({ app }) => {
  const result = await check(app, GOAL, "UCT");
  await expect(result.getByText("Нужно доработать")).toBeVisible();
  // Нарушенное правило отмечено крестиком в списке «Что проверяется».
  await expect(app.locator("aside .checkline .ico.bad")).toHaveCount(1);

  await app.locator("#goalSummary").getByRole("button", { name: "Изменить" }).click();
  await app.locator("#goalInput").fill(GOAL + " в рамках проекта «Альфа»");
  await expect(app.locator("#checkResult")).toHaveCount(0);
  await expect(app.locator("#checkJson")).toHaveCount(0);
  // Уход из раздела и возврат не показывают старый вердикт под новым текстом.
  await go(app, "Атрибуты");
  await go(app, "Проверка цели");
  await expect(app.locator("#goalInput")).toHaveValue(GOAL + " в рамках проекта «Альфа»");
  await expect(app.locator("#checkResult")).toHaveCount(0);
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

test("правило только для студентов проверяется, когда цель ставит студент", async ({ app }) => {
  // Сотрудник: правило для студентов не считается и в списке справа отмечено отдельно.
  let result = await check(app, GOAL, "UCT");
  await expect(result.getByText("не выполнено правил: 1 из 3")).toBeVisible();
  await expect(app.getByText("правил: 3 · только для студентов: 1")).toBeVisible();
  await expect(result.locator(".violation")).not.toContainText("наставника");

  // Студент: правило проверяется, ответ помечен.
  result = await check(app, GOAL, "UCT", true);
  await expect(result.getByText("не выполнено правил: 2 из 4")).toBeVisible();
  await expect(result.locator(".chip", { hasText: "студент" })).toBeVisible();
  await expect(result.locator(".violation").filter({ hasText: "наставника" })).toContainText("Приказ ПР-02, пункт 4.2");
  await expect(app.getByText("правил: 4")).toBeVisible();

  // Признак уходит в запрос булевым полем.
  await app.locator("#checkJson summary").click();
  expect(JSON.parse(await app.locator("#checkJson pre").innerText())).toMatchObject({ is_student: true });

  // Наставник назван — требование выполнено.
  result = await check(app, GOAL + " под руководством наставника", "UCT", true);
  await expect(result.getByText("не выполнено правил: 1 из 4")).toBeVisible();
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
  // Токен есть, а каталог не отвечает: интерфейс открыт, но данных нет.
  await page.addInitScript((tokens) => sessionStorage.setItem("gc.oidc", JSON.stringify(tokens)), mockTokens("admin"));
  await page.route(isApi, (route) => new URL(route.request().url()).pathname === "/api/auth/me"
    ? route.fulfill({ json: { login: "admin", role: "admin", displayName: null, tourSeenAt: "2025-01-10T09:05:00+00:00" } })
    : route.abort());
  await page.goto("/");
  await expect(page.locator(".side").getByText("API недоступен")).toBeVisible();
  await expect(toast(page, "Не удалось получить данные")).toBeVisible();
});

test("без связи с сервером вход не начинается — видна ошибка", async ({ page }) => {
  await page.route(isApi, (route) => route.abort());
  await page.goto("/");
  await page.getByRole("button", { name: "Войти" }).click();
  await expect(page.getByRole("alert")).toContainText("Сервис входа недоступен");
  await expect(page).toHaveURL(/\/$/);
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

test("смена подразделения или «студента» во время проверки: ответ не показывается под новыми значениями", async ({ app }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await app.route("**/api/check-goal", async (route) => { await held; await route.fallback(); });
  await app.getByLabel("Формулировка цели").fill(GOAL);
  await choose(app.locator("#departmentInput"), { value: "UCT" });
  await app.locator("#tab-check").getByRole("button", { name: "Проверить" }).click();
  await expect(app.locator("#tab-check").getByRole("button", { name: /Проверяем/ })).toBeVisible();
  // Пока проверка идёт, сменили подразделение и признак студента.
  await choose(app.locator("#departmentInput"), { value: "FIN" });
  await app.locator("#studentInput").check();
  release();
  await expect(app.locator("#tab-check").getByRole("button", { name: "Проверить" })).toBeEnabled();
  await expect(app.locator("#checkResult")).toHaveCount(0);
  // Вернули значения, с которыми проверяли, — ответ снова на месте.
  await app.locator("#studentInput").uncheck();
  await choose(app.locator("#departmentInput"), { value: "UCT" });
  await expect(app.locator("#checkResult")).toBeVisible();
});
