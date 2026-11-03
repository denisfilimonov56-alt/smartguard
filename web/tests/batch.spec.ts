import type { Download, Page } from "@playwright/test";

import { apiHeaders, choose, expect, go, mockApi, modal, test, toast } from "./fixtures";
import { workbook } from "./xlsx-fixture";

/* Проверка нескольких целей на главном экране: список целей вручную, загрузка
   из Excel с формой проверки файла, выгрузка шаблона и результата. */

const GOAL = "Снизить долю просроченных заявок до 5% к 31.12.2025";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

async function batchMode(page: Page) {
  await go(page, "Проверка цели");
  await page.locator("#checkMode").getByRole("button", { name: "Несколько целей" }).click();
  await expect(page.getByRole("heading", { name: "Проверьте несколько целей" })).toBeVisible();
}

/** Пункты списка целей слева; статус цели — в .s пункта. */
const rows = (page: Page) => page.locator("#batchRows .batch-list li");
const status = (page: Page, i: number) => rows(page).nth(i).locator(".s");
/** Выбранная цель справа: поля и разбор. */
const detail = (page: Page) => page.locator("#batchRows .batch-detail");
const pick = (page: Page, n: number) => rows(page).nth(n - 1).locator("button").click();
const add = (page: Page) => page.getByRole("button", { name: "+ Добавить цель" }).click();
const summary = (page: Page) => page.locator("#batchSummary");
/** Пакет ответил: в сводке столько проверенных целей. */
const checkedCount = (page: Page, n: number) => expect(summary(page)).toHaveAttribute("data-checked", String(n));
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
  await add(app);
  await add(app);
  await expect(rows(app)).toHaveCount(2);
  // Новая цель сразу выбрана.
  await expect(detail(app)).toHaveAttribute("aria-label", "Разбор цели 2");

  await pick(app, 1);
  await app.getByLabel("Цель 1").fill(GOAL);
  await choose(app.getByLabel("Подразделение 1"), "УЦТ");
  await pick(app, 2);
  await app.getByLabel("Цель 2").fill(GOAL);
  await choose(app.getByLabel("Подразделение 2"), "Финансовое управление");
  await app.getByLabel("Идентификатор 2").fill("kpi-2");
  await run(app);

  await checkedCount(app, 2);
  await expect(summary(app)).toContainText("1 без нарушений");
  await expect(summary(app)).toContainText("1 нужно доработать");
  await expect(summary(app)).not.toContainText("ручная проверка");
  // Статус виден в списке, рядом с целью.
  await expect(status(app, 1)).toHaveText("нарушений нет");
  await expect(status(app, 0)).toHaveText("нарушено правил: 1");

  // Разбор выбранной цели — справа.
  await expect(detail(app).locator(".violation")).toHaveCount(0);
  await pick(app, 1);
  await expect(detail(app).locator(".violation")).toContainText("Цель обязана содержать упоминание проекта");
  await expect(detail(app).getByText("не выполнено правил: 1 из 3")).toBeVisible();

  // Ответ API как есть — в меню «⋯», а не на странице.
  await expect(app.locator("#batchJson")).toHaveCount(0);
  await app.locator("#batchMenu").click();
  await app.getByRole("menuitem", { name: "Показать ответ API (JSON)" }).click();
  expect(JSON.parse(await app.locator("#batchJson pre").innerText())).toMatchObject({
    summary: { total: 2, allowed: 1, violations: 1 },
    results: [{ goal: GOAL, status: "VIOLATIONS_FOUND" }, { id: "kpi-2", status: "ALLOWED" }],
  });
  await app.locator("#batchJson").getByRole("button", { name: "Закрыть" }).click();

  // Результат не теряется при переходе между разделами.
  await go(app, "Атрибуты");
  await go(app, "Проверка цели");
  await checkedCount(app, 2);
});

test("отметка «Студент» включает правила только для студентов", async ({ app }) => {
  await batchMode(app);
  await add(app);
  await app.getByLabel("Цель 1").fill(GOAL);
  await choose(app.getByLabel("Подразделение 1"), "УЦТ");
  await app.getByLabel("Студент 1").check();
  await add(app);
  await app.getByLabel("Цель 2").fill(GOAL);
  await choose(app.getByLabel("Подразделение 2"), "УЦТ");
  await run(app);

  await expect(rows(app).nth(0)).toContainText("УЦТ · студент");
  await pick(app, 1);
  await expect(detail(app).getByText("не выполнено правил: 2 из 4")).toBeVisible();
  await expect(detail(app).locator(".violation").filter({ hasText: "наставника" })).toBeVisible();
  await pick(app, 2);
  await expect(detail(app).getByText("не выполнено правил: 1 из 3")).toBeVisible();

  const [result] = await Promise.all([
    app.waitForEvent("download"), app.getByRole("button", { name: "Скачать Excel" }).click(),
  ]);
  const text = await downloaded(result);
  expect(text).toContain("<t>Студент</t>");
  expect(text).toContain("<t>да</t>");
});

test("без подразделения и с пустой целью строки не отправляются", async ({ app }) => {
  await batchMode(app);
  // Без целей проверять нечего: кнопка неактивна, рядом подсказка.
  await expect(app.locator("#batchRun")).toBeDisabled();
  await expect(app.getByText("Добавьте цели, чтобы проверить")).toBeVisible();

  await add(app);
  await expect(status(app, 0)).toHaveText("ошибка в строке");
  await expect(detail(app)).toContainText("Пустая формулировка цели");
  await expect(detail(app)).toContainText("Подразделение не указано");
  await run(app);
  await expect(toast(app, "Сначала исправьте строки с ошибками")).toBeVisible();

  // Подразделение по умолчанию закрывает вторую ошибку, текст цели — первую.
  await choose(app.locator("#batchDepartment"), "По умолчанию: АГД");
  await expect(detail(app)).not.toContainText("Подразделение не указано");
  await app.getByLabel("Цель 1").fill("Пройти обучение по охране труда");
  await expect(detail(app).locator(".row-issues")).toHaveCount(0);
  await run(app);
  await checkedCount(app, 1);
  await expect(rows(app).first()).toContainText("АГД");
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
  await expect(status(app, 3)).toHaveText("ошибка в строке");
  await pick(app, 4);
  await expect(detail(app)).toContainText("Подразделения «XXX» нет в справочнике");
  await expect(app.getByLabel("Подразделение 4")).toContainText("XXX — нет в справочнике");
  await run(app);
  await expect(toast(app, "Сначала исправьте строки с ошибками")).toBeVisible();

  await app.getByRole("button", { name: "Убрать строки с ошибками" }).click();
  await expect(rows(app)).toHaveCount(3);
  await run(app);
  await checkedCount(app, 3);
  await expect(rows(app).nth(0)).toContainText("УЦТ");
  await expect(rows(app).nth(1)).toContainText("Финансовое управление");
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
  await pick(app, 2);
  await expect(app.getByLabel("Подразделение 2")).toContainText("УЦТ");
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
  await expect(rows(app).nth(0)).toContainText("студент");
  await expect(rows(app).nth(1)).not.toContainText("студент");
  await pick(app, 3);
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
  await pick(app, 3);
  await expect(app.getByLabel("Подразделение 3")).toContainText("Финансовое управление");
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
  await app.getByRole("button", { name: "+ Добавить цель" }).click();
  await app.getByLabel("Цель 1").fill(GOAL);
  await choose(app.getByLabel("Подразделение 1"), "УЦТ");
  await run(app);
  await expect(status(app, 0)).toHaveText("нарушено правил: 1");

  await app.getByLabel("Цель 1").fill(GOAL + " в рамках проекта «Альфа»");
  await expect(status(app, 0)).toHaveText("изменено, не проверено");
  await expect(detail(app)).toContainText("Цель изменили после проверки");
  await expect(detail(app).locator(".verdict")).toHaveCount(0);
  // Вернули прежний текст — это снова проверенная строка.
  await app.getByLabel("Цель 1").fill(GOAL);
  await expect(status(app, 0)).toHaveText("нарушено правил: 1");
  await expect(detail(app).locator(".violation")).toBeVisible();
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

  await app.getByRole("button", { name: "+ Добавить цель" }).click();
  await app.getByLabel("Цель 1").fill(GOAL);
  await choose(app.getByLabel("Подразделение 1"), "УЦТ");
  await run(app);
  await checkedCount(app, 1);
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
  await app.getByRole("button", { name: "+ Добавить цель" }).click();
  await app.getByLabel("Цель 1").fill(GOAL);
  await choose(app.getByLabel("Подразделение 1"), "УЦТ");
  await run(app);
  await expect(toast(app, /Пакетная проверка временно отключена администратором/)).toBeVisible();
  await expect(summary(app)).toHaveCount(0);
});

test("API занят другими пакетами (503 + Retry-After): часть повторяется, «Остановить» прерывает ожидание", async ({ page }) => {
  const backend = await mockApi(page, "admin");
  await page.goto("/");
  await expect(page.getByRole("button", { name: /API на связи/ })).toBeVisible();
  await batchMode(page);
  await page.getByRole("button", { name: "+ Добавить цель" }).click();
  await page.getByLabel("Цель 1").fill(GOAL);
  await choose(page.getByLabel("Подразделение 1"), "УЦТ");

  // Два отказа подряд — пакет ждёт и повторяет ту же часть, потом проходит.
  backend.busyBulk(2);
  await run(page);
  await expect(page.locator("#batchRun")).toContainText("очередь занята, повтор через 1 с");
  await checkedCount(page, 1);

  // Остановка во время ожидания повтора: пакет прерывается сразу, без запроса.
  backend.busyBulk(100);
  await run(page);
  await expect(page.locator("#batchRun")).toContainText("очередь занята");
  await page.locator("#batchStop").click();
  await expect(toast(page, "Проверка остановлена")).toBeVisible();
  await expect(page.locator("#batchRun")).toBeEnabled();
});

/** Загрузить n целей из Excel и вернуться к таблице. */
async function uploadGoals(page: Page, n: number) {
  const data = workbook([["Цель", "Подразделение"],
    ...Array.from({ length: n }, (_, i) => [`${GOAL} — цель ${i + 1}`, "UCT"])]);
  const dialog = await upload(page, data);
  await dialog.getByRole("button", { name: `Загрузить ${n} строк` }).click();
  await expect(rows(page)).toHaveCount(n);
}

test("лимит проверок в минуту (429 + Retry-After): пакет ждёт и повторяет ту же часть", async ({ page }) => {
  const backend = await mockApi(page, "admin");
  await page.clock.install();
  await page.goto("/");
  await expect(page.getByRole("button", { name: /API на связи/ })).toBeVisible();
  // Первая часть (50 целей) проходит при пустом окне, вторая упирается в лимит.
  expect(backend.handle("PUT", "/settings", { checkRatePerMinute: 3 }).status).toBe(200);
  await batchMode(page);
  await uploadGoals(page, 60);
  await run(page);
  await expect(page.locator("#batchRun")).toContainText("Проверено 50 из 60 · лимит проверок в минуту, повтор через");

  // Минута прошла — окно освободилось, та же часть уходит снова, пакет заканчивается.
  backend.advanceClock(61);
  await page.clock.fastForward(62_000);
  await checkedCount(page, 60);
});

test("прерванный пакет продолжается с непроверенных строк, проверенные не отправляются снова", async ({ page }) => {
  const backend = await mockApi(page, "admin");
  await page.goto("/");
  await expect(page.getByRole("button", { name: /API на связи/ })).toBeVisible();
  expect(backend.handle("PUT", "/settings", { checkRatePerMinute: 3 }).status).toBe(200);
  await batchMode(page);
  await uploadGoals(page, 60);
  const sent: number[] = [];
  page.on("request", (r) => { if (r.url().endsWith("/api/check-goals")) sent.push(JSON.parse(r.postData() ?? "[]").length); });

  await run(page);
  await expect(page.locator("#batchRun")).toContainText("лимит проверок в минуту");
  await page.locator("#batchStop").click();
  await expect(toast(page, "Проверка остановлена. Проверено 50 из 60")).toBeVisible();
  await checkedCount(page, 50);
  await expect(status(page, 55)).toHaveCount(0);

  // Правка проверенной строки — она тоже уходит в продолжение.
  await page.getByLabel("Цель 1", { exact: true }).fill(GOAL + " в рамках проекта «Альфа»");
  backend.advanceClock(61);
  sent.length = 0;
  await page.locator("#batchContinue").filter({ hasText: "Проверить оставшиеся (11)" }).click();
  await checkedCount(page, 60);
  expect(sent).toEqual([11]);
  await expect(status(page, 0)).toHaveText("нарушений нет");
  await expect(status(page, 59)).toHaveText(/нарушено правил/);
  await expect(page.locator("#batchContinue")).toHaveCount(0);
});

test("цели, которые API не успел проверить до срока пакета (unchecked), уходят в «Проверить оставшиеся»", async ({ page }) => {
  const backend = await mockApi(page, "admin");
  await page.goto("/");
  await expect(page.getByRole("button", { name: /API на связи/ })).toBeVisible();
  await batchMode(page);
  await uploadGoals(page, 5);
  const sent: number[] = [];
  page.on("request", (r) => { if (r.url().endsWith("/api/check-goals")) sent.push(JSON.parse(r.postData() ?? "[]").length); });

  backend.stopBulkAfter(2);
  await run(page);
  await expect(toast(page, /Не проверено целей: 3/)).toBeVisible();
  await expect(status(page, 0)).toHaveText(/нарушено правил/);
  await expect(status(page, 2)).toHaveText("не проверено, отправьте снова");
  // Сводка и список: непроверенные — отдельно, не «проверено» и не «ручная проверка».
  await checkedCount(page, 2);
  await expect(summary(page)).not.toContainText("ручная проверка");
  await expect(page.locator("#batchUnchecked")).toHaveText("3 не проверено");
  await pick(page, 3);
  await expect(detail(page)).toContainText("Пакет не уложился в отведённое время");
  // В Excel — тоже «Не проверено», а не «Ручная проверка».
  const [download] = await Promise.all([
    page.waitForEvent("download"), page.getByRole("button", { name: "Скачать Excel" }).click(),
  ]);
  const text = await downloaded(download);
  expect(text.match(/<t>Не проверено<\/t>/g)).toHaveLength(3);
  expect(text).not.toContain("<t>Ручная проверка</t>");

  sent.length = 0;
  await page.locator("#batchContinue").filter({ hasText: "Проверить оставшиеся (3)" }).click();
  await expect(status(page, 4)).toHaveText(/нарушено правил/);
  expect(sent).toEqual([3]);
  await expect(page.locator("#batchContinue")).toHaveCount(0);
  await checkedCount(page, 5);
  await expect(page.locator("#batchUnchecked")).toHaveCount(0);
});

test("цели с временным сбоем модели (FAILURE_NOTE) «Проверить оставшиеся» отправляет снова", async ({ page }) => {
  const backend = await mockApi(page, "admin");
  await page.goto("/");
  await expect(page.getByRole("button", { name: /API на связи/ })).toBeVisible();
  await batchMode(page);
  await uploadGoals(page, 3);
  const sent: string[][] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/check-goals")) sent.push(JSON.parse(r.postData() ?? "[]").map((i: { goal: string }) => i.goal));
  });

  backend.failBulkGoals(1);
  await run(page);
  await expect(status(page, 0)).toHaveText("сбой, отправьте снова");
  await expect(status(page, 1)).toHaveText(/нарушено правил/);
  await expect(summary(page)).toContainText("1 ручная проверка");

  sent.length = 0;
  await page.locator("#batchContinue").filter({ hasText: "Проверить оставшиеся (1)" }).click();
  await expect(status(page, 0)).toHaveText(/нарушено правил/);
  expect(sent).toEqual([[`${GOAL} — цель 1`]]);
  await expect(summary(page)).not.toContainText("ручная проверка");
  await expect(page.locator("#batchContinue")).toHaveCount(0);
});

test("правила, которые API не проверил (unverified_rule_node_ids), в пакете — «?», а не выполненные", async ({ app }) => {
  // Требование на атрибуте из должностных инструкций; у FIN инструкций нет — правило не проверено.
  await app.evaluate(async (headers) => {
    await fetch("/api/catalog/check-targets", { method: "POST", headers, body: JSON.stringify({
      name: "по_инструкции", description: "цель совпадает с обязанностью", source: "job_descriptions" }) });
    await fetch("/api/catalog/rules", { method: "POST", headers, body: JSON.stringify({
      clauseNodeId: "c:2", type: "REQUIREMENT", checkInstruction: "", description: "Цель опирается на инструкцию",
      targets: ["по_инструкции"] }) });
  }, apiHeaders());
  await app.getByRole("button", { name: "Меню пользователя" }).click();
  await app.getByRole("menuitem", { name: "Обновить" }).click();
  await batchMode(app);
  await app.getByRole("button", { name: "+ Добавить цель" }).click();
  await app.getByLabel("Цель 1").fill("Снизить долю просроченных заявок");
  await choose(app.getByLabel("Подразделение 1"), "Финансовое управление");
  await run(app);

  const item = detail(app);
  await expect(item.locator("[data-rules-line]")).toContainText(/не выполнено правил: \d+ из \d+ · не проверено: 1/);
  await expect(item.locator(".vitem.unverified")).toContainText("Не проверено: 1 правило");
});

test("429 без Retry-After (ограничение частоты у прокси, тело не JSON): пакет ждёт свою паузу", async ({ page }) => {
  await mockApi(page, "admin");
  let throttled = false;
  await page.route("**/api/check-goals", (route) => {
    if (throttled) return route.fallback();
    throttled = true;
    return route.fulfill({ status: 429, contentType: "text/html", body: "<html><body>429 Too Many Requests</body></html>" });
  });
  await page.goto("/");
  await batchMode(page);
  await page.getByRole("button", { name: "+ Добавить цель" }).click();
  await page.getByLabel("Цель 1").fill(GOAL);
  await choose(page.getByLabel("Подразделение 1"), "УЦТ");
  await run(page);
  await expect(page.locator("#batchRun")).toContainText("повтор через 2 с");
  await checkedCount(page, 1);
});

test("подразделение из Excel по названию: одноимённые действующие — ошибка, архивный двойник не мешает", async ({ app }) => {
  await app.evaluate(async (headers) => {
    const post = (departmentId: string, name: string) => fetch("/api/catalog/departments",
      { method: "POST", headers, body: JSON.stringify({ departmentId, name }) }).then((r) => r.json());
    await post("MSK-ACC", "Бухгалтерия");
    await post("SPB-ACC", "Бухгалтерия");
    const old = await post("OLD-STORE", "Склад");
    await fetch(`/api/catalog/nodes/${old.nodeId}/status`, { method: "POST", headers, body: JSON.stringify({ status: "archived" }) });
    await post("STORE", "Склад");
  }, apiHeaders());
  await app.getByRole("button", { name: "Меню пользователя" }).click();
  await app.getByRole("menuitem", { name: "Обновить" }).click();
  await batchMode(app);
  const dialog = await upload(app, workbook([["Цель", "Подразделение"],
    [GOAL, "бухгалтерия"], [GOAL, "SPB-ACC"], [GOAL, "Склад"]]));
  await expect(dialog.locator("#importIssues"))
    .toContainText("строка 2 Название «бухгалтерия» относится к нескольким подразделениям — укажите идентификатор");
  await expect(dialog.locator("#importSummary")).toContainText("с ошибками: 1");
  await expect(dialog.locator(".preview-table tbody tr").nth(2)).toContainText("STORE");
  await expect(dialog.locator(".preview-table tbody tr").nth(2)).not.toContainText("OLD-STORE");
});

test("строки, вставленные из таблицы в пустой пакет, становятся целями", async ({ app }) => {
  await batchMode(app);
  await app.locator("#batchDrop").focus();
  await app.locator("#batchDrop").evaluate((zone) => {
    const data = new DataTransfer();
    data.setData("text/plain", "Цель\tПодразделение\nВнедрить мониторинг до 15.09.2026\tUCT\nСнизить долю просрочек\tAGD\n");
    zone.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(toast(app, "Вставлено: 2 строки")).toBeVisible();
  await expect(app.locator("#batchRun")).toHaveText("Проверить (2)");
});
