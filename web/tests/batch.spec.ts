import type { Download, Page } from "@playwright/test";

import { choose, expect, go, mockApi, modal, test, toast } from "./fixtures";
import { workbook } from "./xlsx-fixture";

/* Проверка нескольких целей на главном экране: таблица вручную, загрузка
   из Excel с формой проверки файла, выгрузка шаблона и результата. */

const GOAL = "Снизить долю просроченных заявок до 5% к 31.12.2025";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

async function batchMode(page: Page) {
  await go(page, "Проверка цели");
  await page.locator("#checkMode").getByRole("button", { name: "Несколько целей" }).click();
  await expect(page.getByRole("heading", { name: "Проверьте несколько целей" })).toBeVisible();
}

const rows = (page: Page) => page.locator("#batchRows tbody tr");
const run = (page: Page) => page.locator("#batchRun").click();

async function upload(page: Page, data: Buffer, name = "цели.xlsx") {
  await page.getByLabel("Файл Excel").setInputFiles({ name, mimeType: XLSX, buffer: data });
  const dialog = modal(page).getByRole("dialog", { name: "Загрузка целей из Excel" });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Скачанный файл — как текст: шаблон и результат пишутся без сжатия, XML читается напрямую. */
const downloaded = async (download: Download) => {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
};

test("несколько целей вручную: ответ по каждой строке и сводка", async ({ app }) => {
  await batchMode(app);
  await app.getByRole("button", { name: "+ Строка" }).click();
  await app.getByRole("button", { name: "+ Строка" }).click();
  await expect(rows(app)).toHaveCount(2);

  await app.getByLabel("Цель 1").fill(GOAL);
  await choose(app.getByLabel("Подразделение 1"), "УЦТ");
  await app.getByLabel("Цель 2").fill(GOAL);
  await choose(app.getByLabel("Подразделение 2"), "Финансовое управление");
  await app.getByLabel("Идентификатор 2").fill("kpi-2");
  await run(app);

  const result = app.locator("#batchResult");
  await expect(result.getByText("Проверено целей: 2")).toBeVisible();
  await expect(result.getByText("нарушений нет: 1")).toBeVisible();
  await expect(result.getByText("нужно доработать: 1")).toBeVisible();
  // Статус виден и в таблице, рядом со строкой.
  await expect(rows(app).nth(1).locator(".badge")).toHaveText("Нарушений нет");
  await expect(rows(app).nth(0).locator(".badge")).toHaveText("Нужно доработать");

  const items = result.locator(".batch-item");
  await expect(items).toHaveCount(2);
  await expect(items.nth(1)).toContainText("kpi-2");
  await items.nth(0).locator("summary").click();
  await expect(items.nth(0).locator(".violation")).toContainText("Цель обязана содержать упоминание проекта");
  await expect(items.nth(0).getByText("не выполнено правил: 1 из 3")).toBeVisible();

  // Под результатом — ответ API как есть; по умолчанию свёрнут, как у одиночной проверки.
  await expect(app.locator("#batchJson pre")).toBeHidden();
  await app.locator("#batchJson summary").click();
  expect(JSON.parse(await app.locator("#batchJson pre").innerText())).toMatchObject({
    summary: { total: 2, allowed: 1, violations: 1 },
    results: [{ goal: GOAL, status: "VIOLATIONS_FOUND" }, { id: "kpi-2", status: "ALLOWED" }],
  });

  // Результат не теряется при переходе между разделами.
  await go(app, "Атрибуты");
  await go(app, "Проверка цели");
  await expect(app.locator("#batchResult").getByText("Проверено целей: 2")).toBeVisible();
});

test("отметка «Студент» включает правила только для студентов", async ({ app }) => {
  await batchMode(app);
  await app.getByRole("button", { name: "+ Строка" }).click();
  await app.getByRole("button", { name: "+ Строка" }).click();
  await app.getByLabel("Цель 1").fill(GOAL);
  await choose(app.getByLabel("Подразделение 1"), "УЦТ");
  await app.getByLabel("Студент 1").check();
  await app.getByLabel("Цель 2").fill(GOAL);
  await choose(app.getByLabel("Подразделение 2"), "УЦТ");
  await run(app);

  const items = app.locator("#batchResult .batch-item");
  await expect(items.nth(0)).toContainText("УЦТ · студент");
  await items.nth(0).locator("summary").click();
  await expect(items.nth(0).getByText("не выполнено правил: 2 из 4")).toBeVisible();
  await expect(items.nth(0).locator(".violation").filter({ hasText: "наставника" })).toBeVisible();
  await items.nth(1).locator("summary").click();
  await expect(items.nth(1).getByText("не выполнено правил: 1 из 3")).toBeVisible();

  const [result] = await Promise.all([
    app.waitForEvent("download"), app.getByRole("button", { name: "Скачать Excel" }).click(),
  ]);
  const text = await downloaded(result);
  expect(text).toContain("<t>Студент</t>");
  expect(text).toContain("<t>да</t>");
});

test("без подразделения и с пустой целью строки не отправляются", async ({ app }) => {
  await batchMode(app);
  await run(app);
  await expect(toast(app, "Добавьте хотя бы одну цель")).toBeVisible();

  await app.getByRole("button", { name: "+ Строка" }).click();
  await expect(rows(app).first()).toContainText("Пустая формулировка цели");
  await expect(rows(app).first()).toContainText("Подразделение не указано");
  await run(app);
  await expect(toast(app, "Сначала исправьте строки с ошибками")).toBeVisible();

  // Подразделение по умолчанию закрывает вторую ошибку, текст цели — первую.
  await choose(app.locator("#batchDepartment"), "По умолчанию: АГД");
  await expect(rows(app).first()).not.toContainText("Подразделение не указано");
  await app.getByLabel("Цель 1").fill("Пройти обучение по охране труда");
  await expect(rows(app).first().locator(".row-issues")).toHaveCount(0);
  await run(app);
  await expect(app.locator("#batchResult").getByText("Проверено целей: 1")).toBeVisible();
  await expect(app.locator("#batchResult .batch-item").first()).toContainText("АГД");
});

test("загрузка из Excel: форма показывает, что нашлось в файле и что с этим не так", async ({ app }) => {
  await batchMode(app);
  const file = workbook([
    ["№", "Формулировка цели", "Подразделение"],
    [1, GOAL, "UCT"],
    [2, "Улучшить работу с заявками", "Финансовое управление"],   // по названию
    [3, "", "AGD"],                                                // пустая цель
    [4, "Пройти обучение", "XXX"],                                 // нет в справочнике
    [5, GOAL, "uct"],                                              // повтор строки 2
    [null, null, null],                                            // пустая строка не считается
  ]);
  const dialog = await upload(app, file);

  // Столбцы узнаны по заголовку.
  await expect(dialog.locator("#importGoal")).toContainText("B — Формулировка цели");
  await expect(dialog.locator("#importDepartment")).toContainText("C — Подразделение");
  await expect(dialog.locator("#importId")).toContainText("A — №");
  const summary = dialog.locator("#importSummary");
  await expect(summary).toContainText("строк: 5");
  await expect(summary).toContainText("с ошибками: 2");
  await expect(summary).toContainText("предупреждений: 1");
  const issues = dialog.locator("#importIssues");
  await expect(issues).toContainText("строка 4 Пустая формулировка цели");
  await expect(issues).toContainText("строка 5 Подразделения «XXX» нет в справочнике");
  await expect(issues).toContainText("строка 6 Повторяет строку 1");
  // Название подразделения заменено идентификатором из справочника.
  await expect(dialog.locator(".preview-table tbody tr").nth(1)).toContainText("FIN");

  await dialog.getByRole("button", { name: "Загрузить 5 строк" }).click();
  await expect(toast(app, "Загружено: 5 строк")).toBeVisible();
  await expect(rows(app)).toHaveCount(5);
  await expect(app.locator("#batchRows").getByText("с ошибками: 2")).toBeVisible();
  await expect(rows(app).nth(3)).toContainText("Подразделения «XXX» нет в справочнике");
  await expect(rows(app).nth(3).getByLabel("Подразделение 4")).toContainText("XXX — нет в справочнике");
  await run(app);
  await expect(toast(app, "Сначала исправьте строки с ошибками")).toBeVisible();

  await app.getByRole("button", { name: "Убрать строки с ошибками" }).click();
  await expect(rows(app)).toHaveCount(3);
  await run(app);
  await expect(app.locator("#batchResult").getByText("Проверено целей: 3")).toBeVisible();
  await expect(app.locator("#batchResult .batch-item").nth(0)).toContainText("УЦТ");
  await expect(app.locator("#batchResult .batch-item").nth(1)).toContainText("Финансовое управление");
});

test("загрузка из Excel: строки с ошибками можно пропустить, подразделение подставить", async ({ app }) => {
  await batchMode(app);
  // Без заголовка: столбцы A, B, C как есть; у второй строки подразделения нет.
  const dialog = await upload(app, workbook([[GOAL, "AGD", "k-1"], ["Улучшить работу с заявками", null, "k-2"], ["", "AGD", "k-3"]]));
  await expect(dialog.getByRole("checkbox", { name: "Первая строка — заголовки" })).not.toBeChecked();
  await expect(dialog.locator("#importSummary")).toContainText("с ошибками: 2");

  await choose(dialog.locator("#importFallback"), "УЦТ");
  await expect(dialog.locator("#importSummary")).toContainText("с ошибками: 1");
  await dialog.getByRole("checkbox", { name: /Пропустить строки с ошибками/ }).check();
  await dialog.getByRole("button", { name: "Загрузить 2 строки" }).click();
  await expect(rows(app)).toHaveCount(2);
  await expect(rows(app).nth(1).getByLabel("Подразделение 2")).toContainText("УЦТ");
  await expect(app.getByLabel("Идентификатор 2")).toHaveValue("k-2");
});

test("загрузка из Excel: логические ячейки TRUE/ЛОЖЬ в столбце «Студент» понимаются, непонятное — предупреждение", async ({ app }) => {
  await batchMode(app);
  // Excel превращает введённые TRUE / ИСТИНА и флажки в логические ячейки <c t="b"><v>1</v></c>.
  const dialog = await upload(app, workbook([
    ["Цель", "Подразделение", "Студент"],
    [GOAL, "UCT", true],
    ["Улучшить работу с заявками", "UCT", false],
    ["Пройти обучение", "UCT", "может быть"],
  ]));
  await expect(dialog.locator("#importStudent")).toContainText("C — Студент");
  const preview = dialog.locator(".preview-table tbody tr");
  await expect(preview.nth(0).locator("td").nth(3)).toHaveText("да");
  await expect(preview.nth(1).locator("td").nth(3)).toHaveText("нет");
  await expect(dialog.locator("#importSummary")).toContainText("предупреждений: 1");
  await expect(dialog.locator("#importIssues")).toContainText("строка 4 Непонятное значение в столбце «Студент»: «может быть»");

  await dialog.getByRole("button", { name: "Загрузить 3 строки" }).click();
  await expect(app.getByLabel("Студент 1")).toBeChecked();
  await expect(app.getByLabel("Студент 2")).not.toBeChecked();
  await expect(app.getByLabel("Студент 3")).not.toBeChecked();
});

test("загрузка из Excel: «Стаж» и «Обучение» не принимаются за столбец «Студент»", async ({ app }) => {
  await batchMode(app);
  const dialog = await upload(app, workbook([
    ["Цель", "Подразделение", "Стаж", "Обучение"],
    [GOAL, "UCT", "да", "да"],
  ]));
  await expect(dialog.locator("#importStudent")).not.toContainText("Стаж");
  await expect(dialog.locator("#importStudent")).not.toContainText("Обучение");
  await expect(dialog.locator("#importSummary")).not.toContainText("предупреждений");
  await dialog.getByRole("button", { name: "Загрузить 1 строку" }).click();
  await expect(app.getByLabel("Студент 1")).not.toBeChecked();
});

test("загрузка из Excel: объединённая ячейка подразделения разносится по строкам группы", async ({ app }) => {
  await batchMode(app);
  await choose(app.locator("#batchDepartment"), "По умолчанию: АГД");
  // «Финансовое управление» объединено на строки 2–4; на странице по умолчанию выбран АГД — он не должен подставиться.
  const dialog = await upload(app, workbook([
    ["Цель", "Подразделение"],
    [GOAL, "FIN"],
    ["Улучшить работу с заявками", null],
    ["Пройти обучение", null],
  ], "Лист1", { merges: ["B2:B5"] }));
  await expect(dialog.locator("#importSummary")).toContainText("строк: 3");
  const preview = dialog.locator(".preview-table tbody tr");
  for (const i of [0, 1, 2]) await expect(preview.nth(i).locator("td").nth(2)).toHaveText("FIN");

  await dialog.getByRole("button", { name: "Загрузить 3 строки" }).click();
  // Объединение «с запасом» (до строки 5) не создаёт пустых строк.
  await expect(rows(app)).toHaveCount(3);
  await expect(rows(app).nth(2).getByLabel("Подразделение 3")).toContainText("Финансовое управление");
});

test("загрузка из Excel: слишком длинный лист отклоняется в окне загрузки, а не роняет страницу", async ({ app }) => {
  await batchMode(app);
  const sheet: (string | null)[][] = [["Цель", "Подразделение"]];
  for (let i = 0; i < 2100; i++) sheet.push([`Цель ${i + 1}`, "UCT"]);
  const dialog = await upload(app, workbook(sheet));
  await expect(dialog.locator("#importError")).toContainText("данные идут дальше строки 2000");
  await dialog.getByRole("button", { name: "Отмена" }).click();
  await expect(app.getByRole("heading", { name: "Проверьте несколько целей" })).toBeVisible();
});

test("загрузка из Excel: «бомба» с поддельным размером обрывается на пределе распаковки", async ({ app }) => {
  await batchMode(app);
  // 70 МБ пробелов сжимаются в ~70 КБ, а заголовок архива уверяет, что лист весит 1 КБ.
  const dialog = await upload(app, workbook([["Цель", "Подразделение"], [GOAL, "UCT"]], "Лист1", { bomb: 70 * 1024 * 1024 }));
  await expect(dialog.locator("#importError")).toContainText("Книга слишком большая");
});

test("загрузка из Excel: объединение до последнего столбца листа не разворачивается в тысячи ячеек", async ({ app }) => {
  await batchMode(app);
  const dialog = await upload(app, workbook([["Цель", "Подразделение"], [GOAL, "UCT"]], "Лист1", { merges: ["B2:XFD2"] }));
  await expect(dialog.locator("#importSummary")).toContainText("строк: 1");
  await dialog.locator("#importDepartment").click();
  await expect(app.locator(".select-pop").getByRole("option")).toHaveCount(3);
  await dialog.locator("#importDepartment").press("Escape");
});

test("правка строки после проверки снимает прежний статус", async ({ app }) => {
  await batchMode(app);
  await app.getByRole("button", { name: "+ Строка" }).click();
  await app.getByLabel("Цель 1").fill(GOAL);
  await choose(app.getByLabel("Подразделение 1"), "УЦТ");
  await run(app);
  await expect(rows(app).nth(0).locator(".badge")).toHaveText("Нужно доработать");

  await app.getByLabel("Цель 1").fill(GOAL + " в рамках проекта «Альфа»");
  await expect(rows(app).nth(0).locator(".badge")).toHaveText("изменено, не проверено");
  // Вернули прежний текст — это снова проверенная строка.
  await app.getByLabel("Цель 1").fill(GOAL);
  await expect(rows(app).nth(0).locator(".badge")).toHaveText("Нужно доработать");
});

test("файл не Excel отклоняется с понятным сообщением", async ({ app }) => {
  await batchMode(app);
  await app.getByLabel("Файл Excel").setInputFiles({ name: "цели.xlsx", mimeType: XLSX, buffer: Buffer.from("это не архив") });
  await expect(toast(app, "Файл не является книгой Excel")).toBeVisible();
  await expect(modal(app).getByRole("dialog")).toHaveCount(0);
});

test("шаблон и результат скачиваются книгами Excel", async ({ app }) => {
  await batchMode(app);
  const [template] = await Promise.all([
    app.waitForEvent("download"), app.getByRole("button", { name: "Скачать шаблон" }).click(),
  ]);
  expect(template.suggestedFilename()).toBe("цели-шаблон.xlsx");
  const templateText = await downloaded(template);
  expect(templateText).toContain("<t>Цель</t>");
  expect(templateText).toContain("<t>Подразделение</t>");
  expect(templateText).toContain("Финансовое управление");

  await app.getByRole("button", { name: "+ Строка" }).click();
  await app.getByLabel("Цель 1").fill(GOAL);
  await choose(app.getByLabel("Подразделение 1"), "УЦТ");
  await run(app);
  await expect(app.locator("#batchResult").getByText("Проверено целей: 1")).toBeVisible();
  const [result] = await Promise.all([
    app.waitForEvent("download"), app.getByRole("button", { name: "Скачать Excel" }).click(),
  ]);
  const resultText = await downloaded(result);
  expect(resultText).toContain(`<t>${GOAL}</t>`);
  expect(resultText).toContain("<t>Нужно доработать</t>");
  expect(resultText).toContain("Цель обязана содержать упоминание проекта");
});

test("выключенная администратором пакетная проверка объясняется, одиночная работает", async ({ app }) => {
  await go(app, "Настройки");
  const bulk = app.getByRole("switch", { name: "Пакетная проверка" });
  await bulk.click();
  await expect(bulk).toHaveAttribute("aria-checked", "false");

  await batchMode(app);
  await app.getByRole("button", { name: "+ Строка" }).click();
  await app.getByLabel("Цель 1").fill(GOAL);
  await choose(app.getByLabel("Подразделение 1"), "УЦТ");
  await run(app);
  await expect(toast(app, /Пакетная проверка временно отключена администратором/)).toBeVisible();
  await expect(app.locator("#batchResult")).toHaveCount(0);
});

test("API занят другими пакетами (503 + Retry-After): часть повторяется, «Остановить» прерывает ожидание", async ({ page }) => {
  const backend = await mockApi(page, "admin");
  await page.goto("/");
  await expect(page.getByText("API на связи")).toBeVisible();
  await batchMode(page);
  await page.getByRole("button", { name: "+ Строка" }).click();
  await page.getByLabel("Цель 1").fill(GOAL);
  await choose(page.getByLabel("Подразделение 1"), "УЦТ");

  // Два отказа подряд — пакет ждёт и повторяет ту же часть, потом проходит.
  backend.busyBulk(2);
  await run(page);
  await expect(page.locator("#batchRun")).toContainText("очередь занята, повтор через 1 с");
  await expect(page.locator("#batchResult").getByText("Проверено целей: 1")).toBeVisible();

  // Остановка во время ожидания повтора: пакет прерывается сразу, без запроса.
  backend.busyBulk(100);
  await run(page);
  await expect(page.locator("#batchRun")).toContainText("очередь занята");
  await page.locator("#batchStop").click();
  await expect(toast(page, "Проверка остановлена")).toBeVisible();
  await expect(page.locator("#batchRun")).toBeEnabled();
});
