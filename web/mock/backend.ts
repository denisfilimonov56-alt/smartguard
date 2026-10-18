/* Фейковый API в памяти: для `npm run dev:mock` и для e2e-тестов.

   Повторяет поведение настоящего API, на которое опирается интерфейс:
   форму ответов и коды (401 без токена из браузера, 403, 404, 409, 422 на
   неверные поля, 503 в режиме обслуживания, 201 на создание, 202 на фоновую
   выписку обязанностей), вход и роли, каскадное удаление, запрет удалять
   используемый атрибут, защиту от двойников по написанию. Проверка цели —
   по ключевым словам, без модели. Это не замена тестам API — те живут
   в api/tests и проверяют настоящий код; меняете контракт API — меняйте и здесь.

   Вход — как с настоящим Keycloak, только Keycloak тоже фейковый: его
   конечные точки живут под /api/idp (страница входа, обмен кода на токен,
   выход), а токены — строки вида mock:<логин>. Учётки фейка: admin, editor,
   viewer — пароль у всех MOCK_PASSWORD. */

type Props = Record<string, unknown>;
type Role = "viewer" | "editor" | "admin";

export const MOCK_PASSWORD = "demo";
const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };
const ROLE_NAMES: Record<Role, string> = { viewer: "читатель", editor: "редактор", admin: "администратор" };

interface MockUser {
  login: string;
  role: Role;
  status: "active" | "blocked";
  displayName: string | null;
  builtin: boolean;
  createdAt: string | null;
  createdBy: string | null;
  lastLoginAt: string | null;
  tourSeenAt: string | null;
  /** Запись привязана к учётной записи Keycloak (sub) при первом входе. */
  bound: boolean;
}
type Label = "Order" | "Clause" | "Rule" | "ViolationExample" | "CheckTarget" | "Department" | "JobDescription";

interface Node {
  id: string;
  label: Label;
  props: Props;
  parent?: string;          // CONTAINS / DEFINES / HAS_EXAMPLE / HAS_JOB_DESCRIPTION
}

export interface Reply {
  status: number;
  body: unknown;
  /** Ответ фейкового Keycloak: страница входа (text/html) или перенаправление (Location). */
  contentType?: string;
  headers?: Record<string, string>;
}

const LOGIN_REQUIRED = "Требуется вход";
const ACCESS_DENIED = "Доступ к интерфейсу не назначен. Обратитесь к администратору";
/** Токены фейкового Keycloak: доступ и обновление — по логину, без подписи. */
const TOKEN_PREFIX = "mock:";
const REFRESH_PREFIX = "mock-refresh:";

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Страница входа фейкового Keycloak: та же форма, что у настоящего, только проще. */
function loginPage(fields: Record<string, string>, error?: string): string {
  const hidden = Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`).join("");
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Вход — Keycloak (фейк)</title>
<style>body{font:15px/1.4 system-ui;background:#f3f4f6;display:grid;place-items:center;min-height:100vh;margin:0}
form{background:#fff;padding:32px;border-radius:8px;width:320px;box-shadow:0 2px 12px rgba(0,0,0,.08)}
label{display:block;margin:12px 0 4px}input{width:100%;box-sizing:border-box;padding:8px}
button{margin-top:16px;width:100%;padding:10px;background:#1e40af;color:#fff;border:0;border-radius:4px}
.error{color:#b91c1c;margin-top:12px}</style></head><body>
<form method="post" action="/api/idp/auth"><h1>Keycloak (фейк)</h1>${hidden}
<label for="username">Логин</label><input id="username" name="username" autofocus autocomplete="username">
<label for="password">Пароль</label><input id="password" name="password" type="password" autocomplete="current-password">
${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}
<button type="submit">Войти</button></form></body></html>`;
}

const BUSINESS_KEYS: Partial<Record<Label, string>> = {
  Order: "orderId", Clause: "clauseId", Rule: "ruleId", ViolationExample: "exampleId", CheckTarget: "name",
  Department: "departmentId", JobDescription: "jobDescriptionId",
};

export const normalizeName = (name: string) =>
  String(name).replace(/ /g, " ").trim().toLowerCase().replace(/ё/g, "е")
    .replace(/[\s-]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly headers?: Record<string, string>) { super(message); }
}

/** Ответ 202: работа принята и идёт в фоне (выписка обязанностей). */
class Accepted {
  constructor(readonly body: unknown) {}
}

/** Предел размера пакета, как MAX_GOALS_PER_REQUEST в api/main.py; длина цели — настройка goalMaxChars. */
const MAX_GOALS_PER_REQUEST = 200;
const MAINTENANCE = "Идёт обслуживание сервиса: проверка целей и каталог временно недоступны. Попробуйте позже";

/** Текст цели, как schemas.GoalText: строка, пробелы по краям срезаются, от 1 до maxChars символов. */
function goalText(value: unknown, maxChars: number, field = "goal"): string {
  if (typeof value !== "string") throw new HttpError(422, `${field}: Input should be a valid string`);
  const text = value.trim();
  if (!text) throw new HttpError(422, `${field}: String should have at least 1 character`);
  if (text.length > maxChars)
    throw new HttpError(422, `${field}: String should have at most ${maxChars} characters`);
  return text;
}

/** Идентификатор из внешней системы, как schemas._id_as_text: число принимается и становится строкой. */
function idText(value: unknown, field: string, min: number, max: number): string {
  const raw = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  if (typeof raw !== "string") throw new HttpError(422, `${field}: Input should be a valid string`);
  const text = raw.trim();
  if (text.length < min) throw new HttpError(422, `${field}: String should have at least ${min} character`);
  if (text.length > max) throw new HttpError(422, `${field}: String should have at most ${max} characters`);
  return text;
}

/** Нестрогий bool, как у pydantic: true/false, 0/1 и строки вида "true", "yes", "on", "1". */
const TRUE_TEXT = new Set(["1", "on", "t", "true", "y", "yes"]);
const FALSE_TEXT = new Set(["0", "off", "f", "false", "n", "no"]);
function laxBool(value: unknown, field: string): boolean {
  if (typeof value === "boolean") return value;
  if (value === 0 || value === 1) return value === 1;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (TRUE_TEXT.has(text)) return true;
    if (FALSE_TEXT.has(text)) return false;
  }
  throw new HttpError(422, `${field}: Input should be a valid boolean`);
}

/** Начальные данные. Приказ ПР-02 заведён без бизнес-ключей — на такой
    конфигурации карточка приказа когда-то не раскрывалась. */
function seed() {
  const nodes: Node[] = [];
  const add = (id: string, label: Label, props: Props, parent?: string) =>
    nodes.push({ id, label, props, parent });

  add("t:1", "CheckTarget", { name: "проект", status: "active",
    description: "в цели явно назван проект, программа или инициатива, в рамках которой ведётся работа" });
  add("t:2", "CheckTarget", { name: "срок_исполнения", status: "active",
    description: "в цели указан проверяемый срок: конкретная дата, месяц, квартал или год" });
  add("t:3", "CheckTarget", { name: "обучение", status: "active", description: "" });
  add("t:4", "CheckTarget", { name: "наставник", status: "active",
    description: "в цели назван наставник или руководитель практики, с которым согласована цель" });

  add("o:1", "Order", { orderId: "PR-01", number: "ПР-01", title: "О порядке постановки целей",
    date: "2024-01-15", status: "active" });
  add("c:1", "Clause", { clauseId: "PR-01/1.1", code: "1.1", status: "active",
    text: "В цели должно быть упоминание проекта, в рамках которого производится работа" }, "o:1");
  add("r:1", "Rule", { ruleId: "R-1.1", type: "REQUIREMENT", status: "active",
    description: "Цель обязана содержать упоминание проекта",
    checkInstruction: "Проверь, указан ли в тексте цели проект." }, "c:1");
  add("e:1", "ViolationExample", { exampleId: "R-1.1-EX1", isViolation: false, status: "active",
    text: "В рамках проекта «Альфа» разработать API для интеграции до 01.06.2025" }, "r:1");
  add("e:2", "ViolationExample", { exampleId: "R-1.1-EX2", isViolation: true, status: "active",
    text: "Реализовать требования по автоматизации процесса в системе 1С:KPI" }, "r:1");
  add("c:2", "Clause", { clauseId: "PR-01/2.4", code: "2.4", status: "active",
    text: "Цель должна иметь конкретные сроки исполнения" }, "o:1");
  add("r:2", "Rule", { ruleId: "R-2.4", type: "REQUIREMENT", status: "active",
    description: "Цель обязана содержать конкретный срок исполнения",
    checkInstruction: "Формулировки 'в ближайшее время', 'по возможности' — нарушение." }, "c:2");
  add("e:3", "ViolationExample", { exampleId: "R-2.4-EX1", isViolation: false, status: "active",
    text: "Внедрить систему мониторинга в проекте «Бета» до 15.09.2025" }, "r:2");

  add("o:2", "Order", { number: "ПР-02", title: "Об обучении персонала" });
  add("c:3", "Clause", { code: "3.1", text: "Цель не должна сводиться к прохождению обучения" }, "o:2");
  add("r:3", "Rule", { type: "PROHIBITION", description: "Обучение само по себе целью не является" }, "c:3");
  // Пункт только для студентов: у целей сотрудников не проверяется.
  add("c:4", "Clause", { clauseId: "PR-02/4.2", code: "4.2", status: "active",
    text: "Цель студента согласуется с наставником" }, "o:2");
  add("r:4", "Rule", { ruleId: "R-4.2", type: "REQUIREMENT", status: "active", studentsOnly: true,
    description: "Цель студента обязана называть наставника",
    checkInstruction: "Укажите наставника, с которым согласована цель." }, "c:4");

  add("d:1", "Department", { departmentId: "UCT", name: "УЦТ", status: "active" });
  add("d:2", "Department", { departmentId: "AGD", name: "АГД", status: "active" });
  add("d:3", "Department", { departmentId: "FIN", name: "Финансовое управление", status: "active" });

  const appliesTo: [string, string][] = [["r:1", "t:1"], ["r:2", "t:2"], ["r:3", "t:3"], ["r:4", "t:4"]];
  const references: [string, string][] = [["c:2", "c:1"]];
  // Проект обязателен только в УЦТ и АГД.
  const onlyIn: [string, string][] = [["r:1", "d:1"], ["r:1", "d:2"]];
  return { nodes, appliesTo, references, onlyIn };
}

/** user — кто делает запросы без заголовка Authorization (вызовы из самих тестов);
    firstLogin — обучение по интерфейсу ещё не пройдено. */
/** bulkBusy — столько первых запросов /check-goals получат 503 с Retry-After: 1, как API сверх BULK_MAX_REQUESTS. */
export function createBackend(options: { user?: string; firstLogin?: boolean; bulkBusy?: number } = {}) {
  let bulkBusy = options.bulkBusy ?? 0;
  const data = seed();
  const mockUser = (login: string, role: Role, displayName: string | null, builtin = false): MockUser =>
    ({ login, role, status: "active", displayName, builtin, createdAt: builtin ? null : "2025-01-10T09:00:00+00:00",
      createdBy: builtin ? null : "admin", lastLoginAt: null, bound: false,
      tourSeenAt: options.firstLogin ? null : "2025-01-10T09:05:00+00:00" });
  const users = new Map<string, MockUser>([
    mockUser("admin", "admin", null, true),
    mockUser("editor", "editor", "Елена Редактор"),
    mockUser("viewer", "viewer", "Виктор Читатель"),
  ].map((u) => [u.login, u]));
  /** Кто делает текущий запрос: из заголовка Authorization (см. handle) либо options.user. */
  let current: string | null = null;
  /** Сессии Keycloak закрыты (срок истёк, выход): токены больше не принимаются, пока не войти заново. */
  let revoked = false;

  const account = (u: MockUser) => ({ login: u.login, role: u.role, displayName: u.displayName, tourSeenAt: u.tourSeenAt });
  /** Пределы API для интерфейса — только в /auth/me, как в api/auth.py; длина цели — из настроек. */
  const limits = () => ({ maxGoalsPerRequest: MAX_GOALS_PER_REQUEST, goalMaxChars: settings.goalMaxChars as number });
  /** Вошедший пользователь с ролью не ниже указанной — как auth.require в API. */
  function need(role: Role) {
    if (!current) throw new HttpError(401, LOGIN_REQUIRED);
    const u = users.get(current);
    if (!u || u.status !== "active") throw new HttpError(403, ACCESS_DENIED);
    if (RANK[u.role] < RANK[role]) throw new HttpError(403, `Недостаточно прав: нужна роль «${ROLE_NAMES[role]}»`);
    return u;
  }
  const userOf = (login: string) => {
    const u = users.get(login);
    if (!u) throw new HttpError(404, `Пользователя '${login}' нет в реестре`);
    return u;
  };
  const guardBuiltin = (u: MockUser) => {
    if (u.builtin)
      throw new HttpError(409, `${u.login} — администратор из AUTH_ADMIN_LOGINS: меняется в настройках сервера`);
  };

  const tokensFor = (login: string) => ({
    access_token: TOKEN_PREFIX + login, refresh_token: REFRESH_PREFIX + login, id_token: "mock-id:" + login,
    token_type: "Bearer", expires_in: 300,
  });

  /** Фейковый Keycloak под /api/idp: страница входа, обмен кода и обновление, выход. */
  function idpRoute(method: string, path: string, query: URLSearchParams, body: any): Reply {
    const form = typeof body === "string" ? new URLSearchParams(body) : new URLSearchParams();
    if (method === "GET" && path === "/idp/.well-known/openid-configuration") {
      const base = "http://localhost/api/idp";
      return { status: 200, body: {
        issuer: base, authorization_endpoint: "/api/idp/auth", token_endpoint: "/api/idp/token",
        end_session_endpoint: "/api/idp/logout", jwks_uri: "/api/idp/certs",
      } };
    }
    if (method === "GET" && path === "/idp/auth") {
      const fields = { redirect_uri: query.get("redirect_uri") ?? "/", state: query.get("state") ?? "" };
      return { status: 200, body: loginPage(fields), contentType: "text/html; charset=utf-8" };
    }
    if (method === "POST" && path === "/idp/auth") {
      const fields = { redirect_uri: form.get("redirect_uri") ?? "/", state: form.get("state") ?? "" };
      const login = (form.get("username") ?? "").trim().toLowerCase();
      // Как у настоящего Keycloak: он знает только, верен ли пароль; роль проверит API.
      if (!login || form.get("password") !== MOCK_PASSWORD)
        return { status: 200, body: loginPage(fields, "Неверный логин или пароль"), contentType: "text/html; charset=utf-8" };
      revoked = false;
      const u = users.get(login);
      if (u) { u.lastLoginAt = new Date().toISOString(); u.bound = true; }
      const target = new URL(fields.redirect_uri, "http://localhost");
      target.searchParams.set("code", "code:" + login);
      target.searchParams.set("state", fields.state);
      return { status: 302, body: null, headers: { Location: target.pathname + target.search } };
    }
    if (method === "POST" && path === "/idp/token") {
      const grant = form.get("grant_type");
      if (grant === "authorization_code") {
        const code = form.get("code") ?? "";
        if (!code.startsWith("code:") || !form.get("code_verifier"))
          return { status: 400, body: { error: "invalid_grant", error_description: "Код входа недействителен" } };
        return { status: 200, body: tokensFor(code.slice("code:".length)) };
      }
      if (grant === "refresh_token") {
        const token = form.get("refresh_token") ?? "";
        if (revoked || !token.startsWith(REFRESH_PREFIX))
          return { status: 400, body: { error: "invalid_grant", error_description: "Сессия закрыта" } };
        return { status: 200, body: tokensFor(token.slice(REFRESH_PREFIX.length)) };
      }
      return { status: 400, body: { error: "unsupported_grant_type" } };
    }
    if (method === "GET" && path === "/idp/logout") {
      revoked = true;
      return { status: 302, body: null, headers: { Location: query.get("post_logout_redirect_uri") ?? "/" } };
    }
    return { status: 404, body: { detail: `Not Found: ${method} ${path}` } };
  }

  function authRoute(method: string, path: string, body: any): unknown {
    if (method === "GET" && path === "/auth/config") return { issuer: "/api/idp", clientId: "mock" };
    if (method === "POST" && path === "/auth/logout") { need("viewer"); return null; }
    if (method === "GET" && path === "/auth/me") return { ...account(need("viewer")), limits: limits() };
    if (method === "POST" && path === "/auth/me/tour") {
      const u = need("viewer");
      u.tourSeenAt = new Date().toISOString();
      return { tourSeenAt: u.tourSeenAt };
    }

    const me = need("admin");
    if (method === "GET" && path === "/auth/users")
      return { users: [...users.values()].sort((a, b) => a.login.localeCompare(b.login)) };
    if (method === "POST" && path === "/auth/users") {
      const login = String(body.login).trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(login))
        throw new HttpError(409, "Логин — латинские буквы, цифры, точка, дефис и подчёркивание, до 64 символов");
      if (users.has(login)) throw new HttpError(409, `Пользователь '${login}' уже есть в реестре`);
      const created = { ...mockUser(login, body.role, String(body.displayName ?? "").trim() || null),
        createdAt: new Date().toISOString(), createdBy: me.login };
      users.set(login, created);
      return created;
    }
    const b = path.match(/^\/auth\/users\/([^/]+)\/binding$/);
    if (b && method === "DELETE") {
      // Как api/auth.py: следующий вход с этим логином привяжет запись заново; builtin — тоже можно.
      const u = userOf(decodeURIComponent(b[1]));
      u.bound = false;
      return u;
    }
    const p = path.match(/^\/auth\/users\/([^/]+)$/);
    if (p && method === "PATCH") {
      const u = userOf(decodeURIComponent(p[1]));
      if (body.role !== undefined || body.status !== undefined) {
        guardBuiltin(u);
        if (u.login === me.login)
          throw new HttpError(409, "Свою роль и статус менять нельзя — попросите другого администратора");
      }
      if (body.role) u.role = body.role;
      if (body.status) u.status = body.status;
      if ("displayName" in body) u.displayName = String(body.displayName ?? "").trim() || null;
      return u;
    }
    if (p && method === "DELETE") {
      const u = userOf(decodeURIComponent(p[1]));
      guardBuiltin(u);
      if (u.login === me.login) throw new HttpError(409, "Свою учётную запись удалить нельзя");
      users.delete(u.login);
      return { deleted: u.login };
    }
    throw new HttpError(404, `Not Found: ${method} ${path}`);
  }
  const nodes = new Map(data.nodes.map((n) => [n.id, n]));
  let appliesTo = data.appliesTo;
  let references = data.references;
  let onlyIn = data.onlyIn;
  let counter = 100;

  const statusOf = (n: Node) => (n.props.status === "archived" ? "archived" : "active");
  const children = (id: string) => [...nodes.values()].filter((n) => n.parent === id);
  const keep = (n: Node, archived: boolean) => archived || statusOf(n) === "active";
  const get = (id: string) => {
    const n = nodes.get(id);
    if (!n) throw new HttpError(404, `Узел ${id} не найден`);
    return n;
  };
  const ofLabel = (id: string, label: Label) => {
    const n = get(id);
    if (n.label !== label) throw new HttpError(404, `Узел ${id} не найден`);
    return n;
  };
  const byCode = (a: Props, b: Props, key: string) => String(a[key] ?? "").localeCompare(String(b[key] ?? ""));
  const targetName = (id: string) => String(nodes.get(id)?.props.name ?? "");
  const ruleTargets = (ruleId: string) =>
    appliesTo.filter(([r]) => r === ruleId).map(([, t]) => targetName(t)).sort();
  const departmentRef = (id: string) => ({
    departmentId: String(nodes.get(id)?.props.departmentId ?? ""), name: nodes.get(id)?.props.name ?? null,
  });
  const departmentById = (departmentId: string) =>
    [...nodes.values()].find((n) => n.label === "Department" && n.props.departmentId === departmentId);
  const withId = (n: Node): Props & { nodeId: string; status: string } =>
    ({ ...n.props, nodeId: n.id, status: statusOf(n) });
  const create = (prefix: string, label: Label, props: Props, parent?: string) => {
    const node: Node = { id: `${prefix}:${++counter}`, label, props: { ...props, status: "active" }, parent };
    nodes.set(node.id, node);
    return { nodeId: node.id, ...node.props };
  };

  function tree(archived: boolean) {
    const orderKey = (n: Node) => String(n.props.number ?? n.props.orderId ?? "");
    const orders = [...nodes.values()].filter((n) => n.label === "Order" && keep(n, archived))
      .sort((a, b) => orderKey(a).localeCompare(orderKey(b)));
    return {
      orders: orders.map((o) => ({
        ...withId(o),
        clauses: children(o.id).filter((c) => keep(c, archived)).map((c) => ({
          ...withId(c),
          rules: children(c.id).filter((r) => keep(r, archived)).map((r) => ({
            ...withId(r),
            targets: ruleTargets(r.id),
            onlyIn: onlyIn.filter(([rule]) => rule === r.id).map(([, d]) => departmentRef(d)),
            studentsOnly: !!r.props.studentsOnly,
            examples: children(r.id).filter((e) => keep(e, archived)).map(withId),
          })).sort((a, b) => byCode(a, b, "ruleId")),
          references: references.filter(([from]) => from === c.id)
            .map(([, to]) => ({ nodeId: to, code: String(nodes.get(to)?.props.code ?? "?") })),
        })).sort((a, b) => byCode(a, b, "code")),
      })),
    };
  }

  function targets(archived: boolean) {
    return [...nodes.values()].filter((n) => n.label === "CheckTarget" && keep(n, archived))
      .sort((a, b) => String(a.props.name).localeCompare(String(b.props.name)))
      .map((t) => ({
        ...withId(t),
        description: String(t.props.description ?? ""),
        rules: appliesTo.filter(([, tid]) => tid === t.id)
          .map(([rid]) => String(nodes.get(rid)?.props.ruleId ?? "")).filter(Boolean).sort(),
      }));
  }

  function departments(archived: boolean) {
    const ruleId = (id: string) => String(nodes.get(id)?.props.ruleId ?? "(без ruleId)");
    return [...nodes.values()].filter((n) => n.label === "Department" && keep(n, archived))
      .sort((a, b) => String(a.props.departmentId).localeCompare(String(b.props.departmentId)))
      .map((d) => ({
        ...withId(d),
        name: String(d.props.name ?? ""),
        onlyRules: onlyIn.filter(([, dep]) => dep === d.id).map(([rule]) => ruleId(rule)),
        jobDescriptions: children(d.id).filter((j) => keep(j, archived)).map((j) => ({
          nodeId: j.id, jobDescriptionId: j.props.jobDescriptionId ?? null, title: String(j.props.title ?? ""),
          status: statusOf(j), chars: String(j.props.text ?? "").length,
          duties: ((j.props.duties as string[] | undefined) ?? []).length, dutiesReviewed: !!j.props.dutiesReviewed,
          dutiesStatus: j.props.dutiesStatus ?? "ready",
        })),
      }));
  }

  /** Узлы подразделений по departmentId, как catalog.set_rule_scope: повтор — 409, неизвестные — 404. */
  function scopeDepartments(only: string[]) {
    const repeated = [...new Set(only.filter((d, i) => only.indexOf(d) !== i))].sort();
    if (repeated.length) throw new HttpError(409, "Подразделение указано дважды: " + repeated.join(", "));
    const unknown = only.filter((d) => !departmentById(d)).sort();
    if (unknown.length) throw new HttpError(404, "Нет таких подразделений: " + unknown.join(", "));
    return only.map((d) => departmentById(d)!.id);
  }

  function setRuleScope(id: string, body: any) {
    ofLabel(id, "Rule");
    const only: string[] = body.only ?? [];
    const ids = scopeDepartments(only);
    onlyIn = [...onlyIn.filter(([rule]) => rule !== id), ...ids.map((d): [string, string] => [id, d])];
    return { only };
  }

  function descendants(id: string) {
    const all: Node[] = [];
    const walk = (pid: string) => children(pid).forEach((c) => { all.push(c); walk(c.id); });
    walk(id);
    return all;
  }

  function counts(id: string) {
    const d = descendants(id);
    return {
      clauses: d.filter((n) => n.label === "Clause").length,
      rules: d.filter((n) => n.label === "Rule").length,
      examples: d.filter((n) => n.label === "ViolationExample").length,
      jobDescriptions: d.filter((n) => n.label === "JobDescription").length,
    };
  }

  function drop(id: string) {
    nodes.delete(id);
    appliesTo = appliesTo.filter(([r, t]) => r !== id && t !== id);
    references = references.filter(([a, b]) => a !== id && b !== id);
    onlyIn = onlyIn.filter(([rule, d]) => rule !== id && d !== id);
  }

  function remove(id: string, force: boolean) {
    const n = get(id);
    if (n.label === "ViolationExample") { drop(id); return { deleted: id, examples: 1 }; }
    if (!force && statusOf(n) !== "archived")
      throw new HttpError(409, "Удалять можно только архивированный узел. Сначала отправьте его в архив.");
    if (n.label === "CheckTarget") {
      const used = appliesTo.filter(([, t]) => t === id).map(([r]) => String(nodes.get(r)?.props.ruleId ?? r));
      if (used.length)
        throw new HttpError(409, `Атрибут используется правилами: ${used.join(", ")}. Сначала отвяжите его.`);
      drop(id);
      return { deleted: id };
    }
    if (n.label === "Department") {
      const used = onlyIn.filter(([, d]) => d === id).map(([rule]) => rule)
        .map((rule) => String(nodes.get(rule)?.props.ruleId ?? rule));
      if (used.length)
        throw new HttpError(409, `Подразделение задаёт область действия правил: ${[...new Set(used)].join(", ")}. `
          + "Сначала уберите его из этих правил.");
      descendants(id).forEach((j) => drop(j.id));
      drop(id);
      return { deleted: id };
    }
    const stats = counts(id);
    descendants(id).forEach((d) => drop(d.id));
    drop(id);
    return { deleted: id, ...stats };
  }

  function patch(id: string, properties: Props) {
    const n = get(id);
    const key = BUSINESS_KEYS[n.label];
    if ("status" in properties) throw new HttpError(409, "Свойство 'status' меняется отдельной операцией");
    if (key && key in properties) {
      const value = properties[key];
      if (value === null || value === "") throw new HttpError(409, `${key} — ключ узла, его нельзя очистить`);
      const clash = [...nodes.values()].find((o) => o.label === n.label && o.id !== id && o.props[key] === value);
      if (clash) throw new HttpError(409, `${key} '${value}' уже занят другим узлом :${n.label}`);
    }
    for (const [k, v] of Object.entries(properties)) {
      if (v === null || (k === "date" && v === "")) delete n.props[k];
      else n.props[k] = v;
    }
    return { nodeId: n.id, labels: [n.label], ...n.props };
  }

  function createTarget(name: string, description: string, source: string | null) {
    const clash = [...nodes.values()].find((n) => n.label === "CheckTarget"
      && normalizeName(String(n.props.name)) === normalizeName(name));
    if (clash)
      throw new HttpError(409, `Атрибут с таким написанием уже есть: "${clash.props.name}". `
        + "Двойники ломают проверку — используйте существующий.");
    return create("t", "CheckTarget", { name, description, ...(source ? { source } : {}) });
  }

  /** Узлы атрибутов по именам; неизвестные — 404 одним списком, как catalog._replace_links. */
  function targetIds(names: string[]) {
    const find = (name: string) => [...nodes.values()].find((n) => n.label === "CheckTarget" && n.props.name === name);
    const unknown = names.filter((name) => !find(name));
    if (unknown.length) throw new HttpError(404, "Нет таких атрибутов: " + unknown.join(", "));
    return names.map((name) => find(name)!.id);
  }

  function setRuleTargets(id: string, names: string[]) {
    ofLabel(id, "Rule");
    const ids = targetIds(names);
    appliesTo = [...appliesTo.filter(([r]) => r !== id), ...ids.map((t): [string, string] => [id, t])];
    return { targets: ruleTargets(id) };
  }

  function diagnostics() {
    const all = [...nodes.values()];
    const active = (label: Label) => all.filter((n) => n.label === label && statusOf(n) === "active");
    const issues: unknown[] = [];
    const issue = (code: string, severity: string, title: string, detail: string,
      items: unknown[] = [], fix: unknown = null) => issues.push({ code, severity, title, detail, items, fix });
    const kindOf = (n: Node) => ({ label: `${n.label} ${n.props.number ?? n.props.code ?? n.props.ruleId ?? n.id}`,
      nodeId: n.id, kind: n.label });

    const noDescription = active("CheckTarget").filter((t) => !String(t.props.description ?? "").trim());
    if (noDescription.length)
      issue("targets_without_description", "error", "Атрибуты без описания",
        "Модель получает в промпте только имя и системно не распознаёт атрибут.",
        noDescription.map((t) => ({ label: String(t.props.name), nodeId: t.id, kind: "CheckTarget" })));

    const noTargets = active("Rule").filter((r) => !appliesTo.some(([rid]) => rid === r.id));
    if (noTargets.length)
      issue("rules_without_target", "error", "Правила без привязки к атрибуту",
        "Правило не участвует ни в одном запросе проверки.", noTargets.map(kindOf));

    const noKey = all.filter((n) => n.label !== "CheckTarget" && n.label !== "Department"
      && !n.props[BUSINESS_KEYS[n.label]!]);
    if (noKey.length)
      issue("missing_identifiers", "error", "Узлы без идентификатора",
        "Без бизнес-ключа узел не попадёт в выгрузку seed.cypher.", noKey.map(kindOf),
        { action: "repair_identifiers", label: "Проставить идентификаторы" });

    const orphans = active("CheckTarget").filter((t) => !appliesTo.some(([, tid]) => tid === t.id));
    if (orphans.length)
      issue("orphan_check_targets", "warning", "Атрибуты без правил",
        "Тратят контекст модели, ни на что не влияя.",
        orphans.map((t) => ({ label: String(t.props.name), nodeId: t.id, kind: "CheckTarget" })));

    const archived = all.filter((n) => statusOf(n) === "archived");
    if (archived.length)
      issue("archived_nodes", "info", "В архиве", "Архивные узлы не участвуют в проверках.",
        [{ label: `Узлов: ${archived.length}` }]);

    const count = (s: string) => issues.filter((i) => (i as { severity: string }).severity === s).length;
    type Shown = { severity: string; title: string; items: { label: string }[] };
    return {
      issues,
      counts: { error: count("error"), warning: count("warning"), info: count("info") },
      check_targets: active("CheckTarget").length,
      ready: count("error") === 0,
      // Как diagnostics.py: плоский список ошибок для /ready и логов.
      problems: (issues as Shown[]).filter((i) => i.severity === "error")
        .map((i) => (i.items.length ? `${i.title}: ${i.items.map((x) => x.label).join(", ")}` : i.title)),
    };
  }

  /** Вместо модели: атрибуты по ключевым словам — и в проверке цели, и в проверке примеров. */
  /** Цитаты «модели»: слово цели, по которому сработало ключевое слово. */
  const quotesByKeywords = (goal: string) => {
    const words: [string, RegExp][] = [
      ["проект", /\S*проект\S*/i], ["срок_исполнения", /\d{2}\.\d{2}\.\d{4}|\S*квартал\S*|\b20\d{2}\b/i],
      ["обучение", /\S*(обучени|курс)\S*/i], ["наставник", /\S*наставни\S*/i],
    ];
    return Object.fromEntries(words.flatMap(([name, re]) => { const m = re.exec(goal); return m ? [[name, m[0]]] : []; }));
  };

  const detectByKeywords = (text: string) => [
    /проект/.test(text) ? "проект" : null,
    /\d{2}\.\d{2}\.\d{4}|квартал|\b20\d{2}\b/.test(text) ? "срок_исполнения" : null,
    /обучени|курс/.test(text) ? "обучение" : null,
    /наставни/.test(text) ? "наставник" : null,
  ].filter((a): a is string => !!a);

  /* Проверка примеров на «модели», как api/examples_check.py. POST отвечает
     «идёт», готовый результат отдаёт следующий GET — так интерфейс проходит
     тот же путь с опросом, что и с настоящим API. */
  let catalogVersion = 0;
  let examplesRun: { report: Record<string, unknown>; version: number } | null = null;

  function runExamples() {
    const active = (n?: Node) => !!n && statusOf(n) === "active";
    const jobNames = [...nodes.values()].filter((n) => n.label === "CheckTarget" && active(n)
      && n.props.source === "job_descriptions").map((n) => String(n.props.name));
    const counts = { matched: 0, mismatched: 0, failed: 0, skipped: 0 };
    const items: Record<string, unknown>[] = [];
    for (const e of nodes.values()) {
      const rule = nodes.get(e.parent ?? "");
      const clause = nodes.get(rule?.parent ?? "");
      const order = nodes.get(clause?.parent ?? "");
      const text = String(e.props.text ?? "").trim();
      if (e.label !== "ViolationExample" || !text || ![e, rule, clause, order].every(active)) continue;
      const names = ruleTargets(rule!.id);
      const item = {
        nodeId: e.id, exampleId: e.props.exampleId ?? null, text, isViolation: !!e.props.isViolation,
        ruleNodeId: rule!.id, ruleId: rule!.props.ruleId ?? null, ruleType: rule!.props.type,
        ruleText: rule!.props.description ?? null, order: order!.props.number ?? null,
        clause: clause!.props.code ?? null, targets: names,
        outcome: "skipped", found: [] as string[], missing: [] as string[], reason: null as string | null,
      };
      if (!names.length) item.reason = "У правила нет действующих атрибутов";
      else if (names.some((n) => jobNames.includes(n)))
        item.reason = "Атрибут определяется по должностным инструкциям подразделения, а у примера подразделения нет";
      else {
        const detected = detectByKeywords(text.toLowerCase());
        item.found = names.filter((n) => detected.includes(n));
        item.missing = names.filter((n) => !detected.includes(n));
        const fires = rule!.props.type === "PROHIBITION" ? item.found.length > 0 : item.missing.length > 0;
        item.outcome = fires === item.isViolation ? "matched" : "mismatched";
      }
      counts[item.outcome as keyof typeof counts]++;
      if (item.outcome !== "matched") items.push(item);
    }
    const rank = { mismatched: 0, failed: 1, skipped: 2 };
    items.sort((a, b) => rank[a.outcome as keyof typeof rank] - rank[b.outcome as keyof typeof rank]);
    const now = new Date().toISOString();
    const total = counts.matched + counts.mismatched;
    examplesRun = {
      version: catalogVersion,
      report: { state: "done", startedAt: now, finishedAt: now, startedBy: current, total, done: total,
        error: null, counts, items },
    };
    return { ...examplesRun.report, state: "running", finishedAt: null, done: 0, stale: false,
      counts: { matched: 0, mismatched: 0, failed: 0, skipped: 0 }, items: [] };
  }

  const examplesStatus = () => examplesRun
    ? { ...examplesRun.report, stale: examplesRun.version !== catalogVersion }
    : { state: "idle", startedAt: null, finishedAt: null, startedBy: null, total: 0, done: 0, error: null,
      stale: false, counts: { matched: 0, mismatched: 0, failed: 0, skipped: 0 }, items: [] };

  /* Советчик, как api/advisor.py: «модель» дописывает обоснование к описанию,
     а предложение считается проверенным. Каталог не меняется. */
  function advice(body: any) {
    const goal = String(body?.goal ?? "");
    const expected = !!body?.expected;
    const target = [...nodes.values()].find((n) => n.label === "CheckTarget" && statusOf(n) === "active"
      && normalizeName(String(n.props.name)) === normalizeName(String(body?.attribute ?? "")));
    if (!target) throw new HttpError(404, `Действующего атрибута "${body?.attribute}" в графе нет`);
    const name = String(target.props.name);
    const present = detectByKeywords(goal.toLowerCase()).includes(name);
    const base = {
      attribute: name, nodeId: target.id, source: target.props.source ?? null, expected,
      current: { present, evidence: quotesByKeywords(goal)[name] ?? null }, already: present === expected,
      diagnosis: null, description: null, regression: null, examples: [],
      examplesInPrompt: !!settings.promptExamples, notes: [] as string[],
    };
    if (base.already)
      return { ...base, notes: ["Модель уже отвечает так, как вы ожидаете: менять граф не нужно. Если проверка "
        + "показала другое, повторите её — ответ мог быть получен до правки каталога."] };
    const rules = appliesTo.filter(([, t]) => t === target.id).map(([r]) => nodes.get(r)!)
      .filter((r) => statusOf(r) === "active" && ruleTargets(r.id).length === 1 && r.props.type);
    const old = String(target.props.description ?? "");
    const checked = rules.flatMap((r) => children(r.id)).filter((e) => statusOf(e) === "active"
      && String(e.props.text ?? "").trim() !== goal.trim()).length;
    return {
      ...base,
      diagnosis: `По текущему описанию атрибут ${present ? "найден" : "не найден"}; в описание добавлено уточнение из обоснования.`,
      description: { old, new: `${old ? old + "; " : ""}уточнение: ${String(body?.reason ?? "").trim()}`,
        verified: true, attempts: 1 },
      regression: { checked, broken: [], alreadyWrong: 0, failed: 0 },
      examples: rules.map((r) => ({
        ruleNodeId: r.id, ruleId: r.props.ruleId ?? null, ruleType: r.props.type, ruleText: r.props.description ?? null,
        isViolation: (r.props.type === "PROHIBITION") === expected,
      })),
      notes: settings.promptExamples ? [] : ["Примеры попадают в промпт только при включённой настройке "
        + "«Примеры в промпте»; без неё пример участвует лишь в проверке примеров."],
    };
  }

  /* Раздел «Настройки»: переключатели проверки и ключи внешних систем. На
     проверку по ключевым словам переключатели в фейке не влияют. */
  const settings: Record<string, boolean | number> = {
    promptExamples: false, injectionGuard: true, evidenceQuotes: true, smartCheck: true, smartCheckBulk: true,
    promptExamplesPerKind: 2,
    checkCache: true, checkCacheTtlSeconds: 3600, jobDescriptionsCacheTtlSeconds: 60, bulkChecks: true,
    checkRatePerMinute: 600, goalMaxChars: 4000, historyEnabled: true, historyRetentionDays: 365, apiKeysEnabled: true,
    maintenance: false, llmMaxConcurrency: 32, llmInteractiveReserve: 4,
  };
  const settingLimits: Record<string, [number, number]> = {
    promptExamplesPerKind: [1, 10], checkCacheTtlSeconds: [0, 604800], jobDescriptionsCacheTtlSeconds: [0, 86400],
    checkRatePerMinute: [0, 100000], goalMaxChars: [100, 8000], historyRetentionDays: [0, 3650],
    llmMaxConcurrency: [1, 256], llmInteractiveReserve: [0, 255],
  };
  /* Очередь к модели, как metrics.gate: предел и резерв — из настроек, резерв не больше предела минус один. */
  const llmLimits = () => {
    const capacity = settings.llmMaxConcurrency as number;
    return { capacity, reserve: Math.min(settings.llmInteractiveReserve as number, capacity - 1) };
  };
  const apiKeys = new Map<string, { keyId: string; name: string; createdAt: string; createdBy: string | null;
    lastUsedAt: string | null }>();
  /* Кэши проверки, как metrics.CACHES: фейк помнит только ключи — чтобы показать
     число записей в «Настройках» и очистить их, целиком или по подразделению. */
  const caches: Record<string, Map<string, string | null>> = {
    results: new Map(), jobDescriptions: new Map(), smart: new Map(), lookups: new Map(),
  };
  const SCOPED_CACHES = ["results", "jobDescriptions"];

  /* Как settings.read_all: резерв в ответе уже обрезан до предела минус один. */
  const settingsView = () => ({ ...settings, llmInteractiveReserve: llmLimits().reserve });

  function settingsRoute(method: string, path: string, body: any): unknown {
    if (path === "/settings" && method === "GET") return settingsView();
    if (path === "/settings" && method === "PUT") {
      const changes = Object.entries(body ?? {}).filter(([key]) => key in settings);
      for (const [key, value] of changes) {
        const limits = settingLimits[key];
        const ok = limits
          ? Number.isInteger(value) && (value as number) >= limits[0] && (value as number) <= limits[1]
          : typeof value === "boolean";
        if (!ok) throw new HttpError(422, `Недопустимое значение настройки ${key}`);
      }
      for (const [key, value] of changes) settings[key] = value as boolean | number;
      // Промпт стал другим — результат проверки примеров устарел.
      if (changes.some(([key]) => ["promptExamples", "injectionGuard", "evidenceQuotes", "promptExamplesPerKind"].includes(key)))
        catalogVersion++;
      return settingsView();
    }
    if (path === "/settings/api-keys" && method === "GET")
      return { keys: [...apiKeys.values()].sort((a, b) => a.name.localeCompare(b.name)) };
    if (path === "/settings/api-keys" && method === "POST") {
      const name = String(body?.name ?? "").trim().replace(/\s+/g, " ");
      if (!name || name.length > 60) throw new HttpError(409, "Название ключа — от 1 до 60 символов");
      if ([...apiKeys.values()].some((k) => k.name.toLowerCase() === name.toLowerCase()))
        throw new HttpError(409, `Ключ с названием '${name}' уже есть`);
      const keyId = (++counter).toString(16).padStart(8, "0");
      const key = { keyId, name, createdAt: new Date().toISOString(), createdBy: current, lastUsedAt: null };
      apiKeys.set(keyId, key);
      return { ...key, key: `gc_${keyId}_mock-secret-${"x".repeat(24)}` };
    }
    if (path === "/settings/caches" && method === "GET") {
      const ttl = (id: string) => id === "results" ? (settings.checkCache ? settings.checkCacheTtlSeconds : 0)
        : id === "jobDescriptions" ? settings.jobDescriptionsCacheTtlSeconds : id === "smart" ? null : 60;
      return { caches: Object.entries(caches).map(([id, map]) =>
        ({ id, entries: map.size, max_entries: 100000, ttl_seconds: ttl(id), hits: 0, misses: 0 })) };
    }
    const c = path.match(/^\/settings\/caches\/([^/]+)\/clear$/);
    if (c && method === "POST") {
      const id = c[1];
      const map = caches[id];
      if (!map) throw new HttpError(404, `Кэша '${id}' нет: ${Object.keys(caches).join(", ")}`);
      const departmentId = typeof body?.departmentId === "string" && body.departmentId.trim() ? body.departmentId.trim() : null;
      if (departmentId && !SCOPED_CACHES.includes(id)) throw new HttpError(422, `Кэш '${id}' не делится по подразделениям`);
      let entries = 0;
      for (const [key, dept] of [...map]) {
        if (departmentId && dept !== departmentId) continue;
        map.delete(key);
        entries++;
      }
      return { cache: id, entries, stored: id === "smart" ? entries : null, departmentId };
    }
    const p = path.match(/^\/settings\/api-keys\/([^/]+)$/);
    if (p && method === "DELETE") {
      if (!apiKeys.delete(decodeURIComponent(p[1])))
        throw new HttpError(404, "Ключ не найден — возможно, его уже отозвали");
      return { deleted: p[1] };
    }
    throw new HttpError(404, `Not Found: ${method} ${path}`);
  }

  function repair() {
    const report = { orders: 0, clauses: 0, rules: 0, examples: 0, jobDescriptions: 0, statuses: 0,
      unnamedTargets: [] as string[], departmentsWithoutId: [] as string[] };
    for (const n of nodes.values()) {
      const key = BUSINESS_KEYS[n.label]!;
      // Как catalog.repair_identifiers: имя атрибута и departmentId подразделения не выдумываются —
      // такие узлы перечисляются, назвать их нужно вручную.
      if (n.label === "CheckTarget") { if (!n.props[key]) report.unnamedTargets.push(n.id); }
      else if (n.label === "Department") { if (!n.props[key]) report.departmentsWithoutId.push(n.id); }
      else if (!n.props[key]) {
        n.props[key] = `${n.label.slice(0, 3).toUpperCase()}-${n.id}`;
        const field = { Order: "orders", Clause: "clauses", Rule: "rules", ViolationExample: "examples",
          JobDescription: "jobDescriptions" }[n.label as "Order"] as "orders";
        report[field]++;
      }
      if (!n.props.status) { n.props.status = "active"; report.statuses++; }
    }
    return report;
  }

  /** «Модель» фейка: обязанность — строка или часть до точки с запятой. */
  const splitDuties = (text: string) => text.split(/[\n;]/).map((line) => line.trim()).filter(Boolean);
  const jobNode = (n: Node) => ({
    nodeId: n.id, labels: [n.label], ...n.props,
    dutiesStatus: n.props.dutiesStatus ?? "ready", dutiesError: n.props.dutiesError ?? null,
  });
  /* Выписка обязанностей, как в API, идёт «в фоне»: запрос отвечает 202 и
     dutiesStatus = pending, а готовый список отдаёт следующий GET инструкции —
     интерфейс проходит тот же путь с опросом, что и с настоящим API. */
  function startDuties(n: Node) {
    Object.assign(n.props, { dutiesStatus: "pending", dutiesError: null });
    return new Accepted(jobNode(n));
  }
  /** Выписка «зависла»: pending остался от прерванного процесса (тест — backend.stallDuties). */
  const stalled = new Set<string>();
  const STALLED = "Выписка прервана (сервис перезапускался) — запустите её заново";
  function finishDuties(n: Node) {
    if (n.props.dutiesStatus !== "pending") return;
    // Как API: pending, которого нет среди идущих задач, — прерванная выписка.
    if (stalled.has(n.id)) {
      stalled.delete(n.id);
      Object.assign(n.props, { dutiesStatus: "error", dutiesError: STALLED });
      return;
    }
    Object.assign(n.props, { duties: splitDuties(String(n.props.text ?? "")), dutiesReviewed: false,
      dutiesStatus: "ready", dutiesError: null });
  }

  /* ---- мониторинг: история в памяти, показатели считаются из неё ---- */
  interface MockRecord {
    at: string; ms: number; status: string; department_id: string | null; login: string | null;
    mode: "single" | "bulk"; batch_id: string | null; cached: boolean; llm_calls: number; llm_ms: number;
    queue_ms: number; violations: string[]; goal: string;
  }
  // Неделя пакетных проверок «от кадровой системы» — чтобы графикам было что показать.
  const history: MockRecord[] = Array.from({ length: 420 }, (_, i) => {
    const status = i % 7 === 0 ? "VIOLATIONS_FOUND" : i % 41 === 0 ? "NEEDS_MANUAL_REVIEW" : "ALLOWED";
    const cached = i % 5 === 0;
    return {
      at: new Date(Date.now() - (i * 24 + 5) * 60_000).toISOString(), ms: cached ? 2 : 900 + (i * 137) % 2600,
      status, department_id: ["UCT", "AGD", "FIN"][i % 3], login: "hr-system", mode: "bulk",
      batch_id: `b${Math.floor(i / 60)}`, cached, llm_calls: cached ? 0 : 2, llm_ms: cached ? 0 : 700 + (i * 91) % 1900,
      queue_ms: cached ? 0 : (i * 53) % 600, violations: status === "VIOLATIONS_FOUND" ? ["R-1.1"] : [],
      goal: `Цель №${i + 1} из пакетной проверки`,
    };
  });
  const TRUNCATE: Record<string, (d: Date) => void> = {
    minute: (d) => d.setSeconds(0, 0), hour: (d) => d.setMinutes(0, 0, 0), day: (d) => d.setHours(0, 0, 0, 0),
    week: (d) => { d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); },
    month: (d) => { d.setHours(0, 0, 0, 0); d.setDate(1); },
  };
  const avg = (values: number[]) => (values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null);
  function aggregate(rows: MockRecord[]) {
    const computed = rows.filter((r) => !r.cached);
    const sorted = rows.map((r) => r.ms).sort((a, b) => a - b);
    return {
      total: rows.length, avg_ms: avg(rows.map((r) => r.ms)), avg_computed_ms: avg(computed.map((r) => r.ms)),
      p95_ms: sorted.length ? sorted[Math.floor((sorted.length - 1) * 0.95)] : null, max_ms: sorted.at(-1) ?? null,
      avg_queue_ms: avg(computed.map((r) => r.queue_ms)), avg_llm_ms: avg(computed.map((r) => r.llm_ms)),
      llm_calls: rows.reduce((n, r) => n + r.llm_calls, 0), cached: rows.length - computed.length,
      allowed: rows.filter((r) => r.status === "ALLOWED").length,
      violations: rows.filter((r) => r.status === "VIOLATIONS_FOUND").length,
      manual_review: rows.filter((r) => r.status === "NEEDS_MANUAL_REVIEW").length,
    };
  }
  function monitoring(path: string, query: URLSearchParams) {
    if (path === "/monitoring/now") {
      const recent = history.filter((r) => Date.parse(r.at) > Date.now() - 300_000);
      return {
        llm: { ...llmLimits(), running: 0, waiting: 0 },
        checks: { running: 0, queued: 0, batches: [] },
        recent: { window_seconds: 300, checks: recent.length, per_minute: recent.length / 5,
          avg_ms: aggregate(recent).avg_computed_ms, cached: recent.filter((r) => r.cached).length,
          manual_review: recent.filter((r) => r.status === "NEEDS_MANUAL_REVIEW").length },
        cache: { entries: 0, max_entries: 100000,
          ttl_seconds: settings.checkCache ? settings.checkCacheTtlSeconds : 0, hits: 0, misses: 0 },
        history: { pending: 0, dropped: 0, retention_days: settings.historyRetentionDays,
          enabled: settings.historyEnabled },
        vllm: { running: 0, waiting: 0, kv_cache_usage: 0.02 }, neo4j: true, uptime_seconds: 3600,
      };
    }
    const start = Date.parse(query.get("start") ?? ""), end = Date.parse(query.get("end") ?? "");
    if (Number.isNaN(start) || Number.isNaN(end)) throw new HttpError(422, "Укажите период: start и end");
    const mode = query.get("mode");
    const rows = history.filter((r) => Date.parse(r.at) >= start && Date.parse(r.at) < end && (!mode || r.mode === mode));
    if (path === "/monitoring/history")
    {
      const offset = Number(query.get("offset") ?? 0);
      return { total: rows.length, records: [...rows].sort((a, b) => b.at.localeCompare(a.at))
        .slice(offset, offset + Number(query.get("limit") ?? 10)) };
    }
    const step = query.get("step") ?? "day";
    if (!TRUNCATE[step]) throw new HttpError(422, `Недопустимая периодичность '${step}'`);
    const groups = new Map<string, MockRecord[]>();
    for (const r of rows) {
      const d = new Date(r.at);
      TRUNCATE[step](d);
      groups.set(d.toISOString(), [...(groups.get(d.toISOString()) ?? []), r]);
    }
    return {
      step, timezone: query.get("timezone") ?? "UTC", totals: aggregate(rows),
      buckets: [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
        .map(([bucket, group]) => ({ bucket, ...aggregate(group) })),
    };
  }

  const GRAPH_CAPTIONS: Record<Label, [string, string]> = {
    Order: ["number", "title"], Clause: ["code", "text"], Rule: ["ruleId", "description"],
    CheckTarget: ["name", "description"], ViolationExample: ["exampleId", "text"],
    Department: ["name", "departmentId"], JobDescription: ["title", "jobDescriptionId"],
  };
  const PARENT_EDGE: Partial<Record<Label, string>> = {
    Clause: "CONTAINS", Rule: "DEFINES", ViolationExample: "HAS_EXAMPLE", JobDescription: "HAS_JOB_DESCRIPTION",
  };
  function graph() {
    const edge = (source: string, target: string, type: string, status: string | null = null) =>
      ({ source, target, type, status });
    return {
      nodes: [...nodes.values()].map((n) => ({
        id: n.id, label: n.label, title: String(n.props[GRAPH_CAPTIONS[n.label][0]] ?? "?"),
        detail: String(n.props[GRAPH_CAPTIONS[n.label][1]] ?? "").slice(0, 300), status: statusOf(n),
        ...(n.label === "Rule" && n.props.type ? { type: n.props.type } : {}),
      })),
      edges: [
        ...[...nodes.values()].filter((n) => n.parent).map((n) => edge(n.parent!, n.id, PARENT_EDGE[n.label]!)),
        ...appliesTo.map(([r, t]) => edge(r, t, "APPLIES_TO")),
        ...references.map(([a, b]) => edge(a, b, "REFERENCES")),
        ...onlyIn.map(([r, d]) => edge(r, d, "ONLY_IN")),
      ],
    };
  }

  /** Упрощённая проверка цели: атрибуты «находятся» по ключевым словам, а
      дублирование обязанности — по вхождению её строки из инструкции в цель. */
  function checkGoal(goal: string, departmentId: string | null, isStudent: boolean | null,
    batchId: string | null = null) {
    const notes = ["Ответ фейкового API: атрибуты определены по ключевым словам, без модели."];
    const allRules = "применены все правила, включая действующие только в отдельных "
      + "подразделениях.";
    const found = departmentId ? departmentById(departmentId.trim()) : undefined;
    let department: Node | undefined;
    if (!departmentId?.trim()) notes.push("Подразделение не передано: " + allRules);
    else if (!found) notes.push(`Подразделения "${departmentId}" нет в графе (:Department): ${allRules}`);
    else if (statusOf(found) !== "active") notes.push(`Подразделение "${departmentId}" находится в архиве: ${allRules}`);
    else department = found;
    // Как agent.resolve_student: без признака правила для студентов не отключаются.
    if (isStudent == null)
      notes.push("Признак студента (is_student) не передан: применены все правила, "
        + "включая действующие только для студентов.");

    const text = goal.toLowerCase();
    const detected = detectByKeywords(text);

    const applies = (r: Node) => {
      const clause = nodes.get(r.parent!)!;
      const order = nodes.get(clause.parent!)!;
      if (statusOf(clause) !== "active" || statusOf(order) !== "active") return false;
      const restricted = onlyIn.filter(([rule]) => rule === r.id).map(([, d]) => d);
      if (department && restricted.length && !restricted.includes(department.id)) return false;
      return !(r.props.studentsOnly && isStudent === false);
    };
    const activeRules = [...nodes.values()].filter((n) => n.label === "Rule" && statusOf(n) === "active" && applies(n));

    // Атрибуты, определяемые по должностным инструкциям: как agent.check_job_targets.
    const jobNames = [...nodes.values()].filter((n) => n.label === "CheckTarget" && statusOf(n) === "active"
      && n.props.source === "job_descriptions").map((n) => String(n.props.name));
    const jobRules = activeRules.filter((r) => ruleTargets(r.id).some((t) => jobNames.includes(t)));
    const matched: { job_description_id: unknown; title: unknown; duty: string }[] = [];
    let unverified = false;
    if (jobRules.length) {
      const docs = department ? children(department.id).filter((j) => statusOf(j) === "active") : [];
      const reason = !department ? "подразделение не определено."
        : !docs.length ? `для подразделения "${department.props.name}" они не загружены.` : null;
      if (reason) {
        notes.push(`Цель не сравнивалась с должностными инструкциями: ${reason} Правило проверьте вручную.`);
        unverified = true;
      }
      for (const doc of docs)
        for (const line of (doc.props.duties as string[] | undefined) ?? splitDuties(String(doc.props.text ?? ""))) {
          const duty = line.trim().replace(/[.,]$/, "");
          if (duty.length > 5 && text.includes(duty.toLowerCase()))
            matched.push({ job_description_id: doc.props.jobDescriptionId ?? null, title: doc.props.title ?? null, duty });
        }
      if (matched.length) detected.push(...jobNames);
    }

    const violations = [];
    for (const r of activeRules) {
      const clause = nodes.get(r.parent!)!;
      const order = nodes.get(clause.parent!)!;
      for (const name of ruleTargets(r.id)) {
        const present = detected.includes(name);
        const prohibition = r.props.type === "PROHIBITION";
        if (prohibition ? !present : present) continue;
        violations.push({
          rule_node_id: r.id,
          order_number: order.props.number ?? null, order_title: order.props.title ?? null,
          clause_code: clause.props.code ?? null, clause_text: clause.props.text ?? null,
          rule_id: r.props.ruleId ?? null, rule_text: r.props.description ?? null,
          check_instruction: r.props.checkInstruction ?? null,
          violation_type: prohibition ? "PROHIBITION" : "MISSING_REQUIREMENT",
          attribute: name,
          example_kind: prohibition ? "violation" : "correct",
          examples: children(r.id).filter((e) => statusOf(e) === "active"
            && !!e.props.isViolation === prohibition).map((e) => e.props.text),
          ...(jobNames.includes(name) ? { matched_duties: matched } : {}),
        });
      }
    }
    const status = violations.length ? "VIOLATIONS_FOUND" : unverified ? "NEEDS_MANUAL_REVIEW" : "ALLOWED";
    history.push({
      at: new Date().toISOString(), ms: 1200, status, department_id: department ? String(department.props.departmentId) : null,
      login: current, mode: batchId ? "bulk" : "single", batch_id: batchId, cached: false, llm_calls: 1, llm_ms: 1100,
      queue_ms: 0,
      violations: violations.map((v) => String(v.rule_id ?? "?")), goal: goal.slice(0, 500),
    });
    // Что запомнил бы настоящий сервис (metrics.CACHES) — для карточки «Кэш проверки».
    const deptId = department ? String(department.props.departmentId) : null;
    if (settings.checkCache) caches.results.set(`${goal.trim()}|${deptId ?? ""}|${isStudent}`, deptId);
    if (deptId) caches.jobDescriptions.set(deptId, deptId);
    if (settings.smartCheck && (!batchId || settings.smartCheckBulk)) caches.smart.set(goal.trim(), null);
    caches.lookups.set("settings", null);
    return {
      goal, status, allowed: status === "ALLOWED",
      department: department
        ? { id: String(department.props.departmentId), name: String(department.props.name ?? "") } : null,
      is_student: isStudent,
      detected_attributes: detected, attribute_quotes: settings.evidenceQuotes ? quotesByKeywords(goal) : {},
      smart: settings.smartCheck && (!batchId || settings.smartCheckBulk) ? smartScores(goal) : null,
      violations, notes,
    };
  }

  /** Оценка по SMART «на глаз» — как agent.assess_smart, но по признакам в тексте, чтобы ответ был предсказуем. */
  function smartScores(goal: string) {
    const text = goal.toLowerCase();
    const words = text.split(/\s+/).filter(Boolean).length;
    const dated = /\d{2}\.\d{2}\.\d{4}|\bк \d|\bдо \d|квартал|полугод|\d{4}\s*г/.test(text);
    const numbered = /\d+\s*%|\bна \d|\bдо \d|\d+\s*(шт|ед|чел|руб|дн)/.test(text);
    const vague = /^(улучшить|повысить|усилить|наладить|проработать)\b/.test(text) && words < 6;
    const linked = /проект|программ|заявк|клиент|подразделен|отдел|процесс|сервис/.test(text);
    const pick = (ok: boolean, yes: string, no: string, hi = 85, lo = 25) =>
      ({ score: ok ? hi : lo, comment: ok ? yes : no });
    return {
      specific: pick(!vague && words >= 4, "Названы предмет и ожидаемый результат.",
        "Непонятно, что именно должно измениться: нет предмета и результата.", vague ? 80 : 75, vague ? 20 : 35),
      measurable: pick(numbered, "Есть числовой показатель, по которому виден результат.",
        "Нет показателя, по которому можно понять, что цель достигнута."),
      achievable: pick(words >= 4 && words <= 40, "Объём работы выглядит посильным для исполнителя.",
        "Из формулировки не видно, посилен ли результат.", 70, 45),
      relevant: pick(linked, "Видна связь с задачами подразделения или проектом.",
        "Не указано, зачем цель нужна и с чем связана.", 75, 30),
      time_bound: pick(dated, "Назван срок достижения результата.", "Срок или период не указан.", 90, 10),
    };
  }

  /** is_student — не передано или нестрогий bool: pydantic без StrictBool принимает
      и "true"/"yes"/1, а "maybe" и 2 — 422. */
  function studentFlag(value: unknown): boolean | null {
    return value == null ? null : laxBool(value, "is_student");
  }

  /** Пакетная проверка — как main.check_many: поля проверяются схемой GoalItem, затем
      предел размера и выключатель. */
  function checkGoals(body: unknown) {
    // Как api/main.py: одновременных пакетов больше BULK_MAX_REQUESTS — 503 и Retry-After.
    if (bulkBusy > 0) {
      bulkBusy--;
      throw new HttpError(503, "Слишком много одновременных пакетных проверок, повторите позже", { "Retry-After": "1" });
    }
    if (!Array.isArray(body)) throw new HttpError(422, "Ожидался массив целей");
    const items = body.map((item: any) => ({
      goal: goalText(item?.goal, settings.goalMaxChars as number),
      department_id: idText(item?.department_id, "department_id", 1, 100),
      is_student: studentFlag(item?.is_student),
      id: item?.id == null ? null : idText(item.id, "id", 0, 200),
    }));
    if (items.length > MAX_GOALS_PER_REQUEST)
      throw new HttpError(413, `За один раз можно проверить не более ${MAX_GOALS_PER_REQUEST} целей, передано ${items.length}`);
    if (!settings.bulkChecks)
      throw new HttpError(503, "Пакетная проверка временно отключена администратором. Цели можно проверять по одной");
    const batchId = (++counter).toString(16);
    const results = items.map((item) => ({
      id: item.id,
      ...checkGoal(item.goal, item.department_id, item.is_student, batchId),
    }));
    const count = (status: string) => results.filter((r) => r.status === status).length;
    return { results, summary: { total: results.length, allowed: count("ALLOWED"),
      violations: count("VIOLATIONS_FOUND"), manual_review: count("NEEDS_MANUAL_REVIEW") } };
  }

  function route(method: string, path: string, query: URLSearchParams, body: any): unknown {
    const archived = query.get("include_archived") === "true";
    const m = (re: RegExp) => path.match(re);
    let p: RegExpMatchArray | null;

    if (method === "GET" && path === "/health") return { status: "ok" };
    if (path.startsWith("/auth/")) return authRoute(method, path, body);
    // Те же права, что в api/routes.py: читать может любой вошедший, менять —
    // редактор, удалять навсегда и чинить идентификаторы — администратор.
    const user = need(method === "DELETE" || path === "/catalog/repair-identifiers"
      || path === "/catalog/merge-duplicate-targets" || path.startsWith("/monitoring/")
      || path.startsWith("/settings") ? "admin"
      : method === "GET" || path === "/check-goal" || path === "/check-goals" ? "viewer" : "editor");
    // Обслуживание, как auth.require: работает только администратор; вход и /auth/me остаются.
    if (settings.maintenance && user.role !== "admin") throw new HttpError(503, MAINTENANCE);
    if (path.startsWith("/settings")) return settingsRoute(method, path, body);
    if (method === "GET" && path === "/catalog/tree") return tree(archived);
    if (method === "GET" && path === "/catalog/check-targets") return { targets: targets(archived) };
    if (method === "GET" && path === "/catalog/clauses")
      return {
        clauses: [...nodes.values()].filter((n) => n.label === "Clause").map((c) => ({
          nodeId: c.id, code: String(c.props.code ?? "?"), status: statusOf(c),
          order_number: String(nodes.get(c.parent!)?.props.number ?? nodes.get(c.parent!)?.props.orderId ?? "?"),
        })).sort((a, b) => (a.order_number + a.code).localeCompare(b.order_number + b.code)),
      };
    if (method === "GET" && path === "/catalog/departments") return { departments: departments(archived) };
    if (method === "GET" && path === "/catalog/diagnostics") return diagnostics();
    if (method === "GET" && path === "/catalog/graph") return graph();
    if (path === "/catalog/examples-check") {
      if (method === "GET") return examplesStatus();
      if (method === "POST") return runExamples();
    }
    if (method === "POST" && path === "/catalog/advice") return advice(body);
    // Любая правка каталога делает результат проверки примеров устаревшим.
    if (method !== "GET" && path.startsWith("/catalog/")) catalogVersion++;
    if (method === "GET" && /^\/monitoring\/(now|stats|history)$/.test(path)) return monitoring(path, query);
    if (method === "POST" && path === "/catalog/repair-identifiers") return repair();
    // Двойников по написанию мок не заводит: сводить нечего.
    if (method === "POST" && path === "/catalog/merge-duplicate-targets") return { merged: [], skipped: [] };
    if (method === "POST" && path === "/check-goal") {
      const department = body?.department_id;
      if (department != null && typeof department !== "string")
        throw new HttpError(422, "department_id: Input should be a valid string");
      return checkGoal(goalText(body?.goal, settings.goalMaxChars as number), department ?? null, studentFlag(body?.is_student));
    }
    if (method === "POST" && path === "/check-goals") return checkGoals(body);

    if ((p = m(/^\/catalog\/nodes\/([^/]+)$/))) {
      const id = decodeURIComponent(p[1]);
      if (method === "GET") { const n = get(id); return { nodeId: n.id, labels: [n.label], ...n.props }; }
      if (method === "DELETE") return remove(id, query.get("force") === "true");
    }
    if ((p = m(/^\/catalog\/nodes\/([^/]+)\/(properties|status|descendants)$/))) {
      const id = decodeURIComponent(p[1]);
      if (p[2] === "properties" && method === "PATCH") return patch(id, body?.properties ?? {});
      if (p[2] === "status" && method === "POST") {
        if (body?.status !== "active" && body?.status !== "archived")
          throw new HttpError(422, "status: Input should be 'active' or 'archived'");
        get(id).props.status = body.status;
        return { nodeId: id, status: body.status };
      }
      if (p[2] === "descendants" && method === "GET") { get(id); return counts(id); }
    }

    if (method === "POST" && path === "/catalog/orders") {
      const orderId = body.orderId || String(body.number).toUpperCase().replace(/[^\p{L}\p{N}]+/gu, "-");
      if ([...nodes.values()].some((n) => n.label === "Order" && n.props.orderId === orderId))
        throw new HttpError(409, `orderId '${orderId}' уже занят`);
      return create("o", "Order", { number: body.number, title: body.title, orderId,
        ...(body.date ? { date: body.date } : {}) });
    }
    if (method === "POST" && path === "/catalog/clauses") {
      const order = ofLabel(body.orderNodeId, "Order");
      return create("c", "Clause", { code: body.code, text: body.text,
        clauseId: `${order.props.orderId ?? "ORD"}/${body.code}` }, order.id);
    }
    if (method === "POST" && path === "/catalog/rules") {
      if (body?.type !== "PROHIBITION" && body?.type !== "REQUIREMENT")
        throw new HttpError(422, "type: Input should be 'PROHIBITION' or 'REQUIREMENT'");
      // Как catalog.create_rule: атрибуты и подразделения проверяются до создания —
      // при ошибке правило не остаётся в графе наполовину заполненным.
      ofLabel(body.clauseNodeId, "Clause");
      const targetsOf = targetIds(body.targets ?? []);
      const only = scopeDepartments(body.only ?? []);
      const rule = create("r", "Rule", { type: body.type, description: body.description,
        checkInstruction: body.checkInstruction ?? "", studentsOnly: !!body.studentsOnly, ruleId: `R-${counter + 1}` },
      body.clauseNodeId);
      appliesTo = [...appliesTo, ...targetsOf.map((t): [string, string] => [rule.nodeId, t])];
      onlyIn = [...onlyIn, ...only.map((d): [string, string] => [rule.nodeId, d])];
      return rule;
    }
    if (method === "POST" && path === "/catalog/examples") {
      ofLabel(body.ruleNodeId, "Rule");
      return create("e", "ViolationExample", { text: body.text, isViolation: !!body.isViolation,
        exampleId: `EX-${counter + 1}` }, body.ruleNodeId);
    }
    if (method === "POST" && path === "/catalog/check-targets")
      return createTarget(String(body.name), String(body.description ?? ""), body.source ?? null);
    if (method === "POST" && path === "/catalog/job-descriptions") {
      const department = ofLabel(body.departmentNodeId, "Department");
      const title = String(body.title).trim();
      const created = create("j", "JobDescription", { title, text: String(body.text).trim(),
        jobDescriptionId: `${department.props.departmentId}/${normalizeName(title)}-${counter + 1}` }, department.id);
      return startDuties(get(created.nodeId));
    }
    if ((p = m(/^\/catalog\/job-descriptions\/([^/]+)(\/extract-duties|\/duties)?$/))) {
      const n = ofLabel(decodeURIComponent(p[1]), "JobDescription");
      if (method === "GET" && !p[2]) {
        finishDuties(n);
        return jobNode(n);
      }
      if (method === "PUT" && !p[2]) {
        const changed = String(body.text).trim() !== n.props.text;
        Object.assign(n.props, { title: String(body.title).trim(), text: String(body.text).trim() });
        if (!changed) return jobNode(n);
        Object.assign(n.props, { duties: [], dutiesReviewed: false });
        return startDuties(n);
      }
      if (method === "POST" && p[2] === "/extract-duties") {
        // Зависшая выписка перезапускается (202); идущая — 409.
        if (n.props.dutiesStatus === "pending" && !stalled.delete(n.id))
          throw new HttpError(409, "Обязанности уже выписываются — дождитесь окончания");
        return startDuties(n);
      }
      if (method === "PUT" && p[2] === "/duties") {
        // Как catalog.set_job_duties: пробелы схлопываются, пустые и повторы отбрасываются,
        // а ручной список заменяет и идущую выписку.
        const duties = [...new Set((body.duties as string[]).map((d) => String(d).split(/\s+/).join(" ").trim())
          .filter(Boolean))];
        if (duties.length > 300) throw new HttpError(409, `Слишком длинный список обязанностей: ${duties.length}, допустимо 300`);
        Object.assign(n.props, { duties, dutiesReviewed: true, dutiesStatus: "ready", dutiesError: null });
        return jobNode(n);
      }
    }

    if (method === "POST" && path === "/catalog/departments") {
      const departmentId = String(body.departmentId).trim();
      if (departmentById(departmentId))
        throw new HttpError(409, `Подразделение с идентификатором '${departmentId}' уже существует`);
      return create("d", "Department", { departmentId, name: String(body.name).trim() });
    }

    if (method === "PUT" && (p = m(/^\/catalog\/rules\/([^/]+)\/audience$/))) {
      const rule = ofLabel(decodeURIComponent(p[1]), "Rule");
      if (typeof body?.studentsOnly !== "boolean") throw new HttpError(422, "studentsOnly: Field required");
      rule.props.studentsOnly = body.studentsOnly;
      return { studentsOnly: body.studentsOnly };
    }
    if (method === "PUT" && (p = m(/^\/catalog\/rules\/([^/]+)\/departments$/)))
      return setRuleScope(decodeURIComponent(p[1]), body ?? {});
    if (method === "PUT" && (p = m(/^\/catalog\/rules\/([^/]+)\/targets$/)))
      return setRuleTargets(decodeURIComponent(p[1]), body.targets ?? []);
    if (method === "PUT" && (p = m(/^\/catalog\/clauses\/([^/]+)\/references$/))) {
      const id = decodeURIComponent(p[1]);
      ofLabel(id, "Clause");
      const to = (body.references as string[]) ?? [];
      if (to.includes(id)) throw new HttpError(409, "Пункт не может ссылаться сам на себя");
      to.forEach((target) => ofLabel(target, "Clause"));
      references = [...references.filter(([a]) => a !== id),
        ...(body.references as string[]).map((to): [string, string] => [id, to])];
      return { references: body.references };
    }
    if (method === "POST" && (p = m(/^\/catalog\/(clauses|rules)\/([^/]+)\/move$/))) {
      const [label, parentLabel]: [Label, Label] = p[1] === "clauses" ? ["Clause", "Order"] : ["Rule", "Clause"];
      const n = ofLabel(decodeURIComponent(p[2]), label);
      const parent = ofLabel(body.parentNodeId, parentLabel);
      // Как catalog._assert_active_parent: в архивном родителе узел молча выпал бы из проверок.
      if (statusOf(parent) !== "active")
        throw new HttpError(409, `Нельзя перенести в архивный ${parentLabel === "Order" ? "приказ" : "пункт"}. `
          + "Сначала верните его из архива.");
      n.parent = parent.id;
      return { nodeId: n.id, parentNodeId: n.parent };
    }
    throw new HttpError(404, `Not Found: ${method} ${path}`);
  }

  return {
    /** Закрыть сессии Keycloak: выданные токены перестают приниматься, как после выхода или по сроку. */
    revoke() { revoked = true; },
    /** Следующие n запросов /check-goals получат 503 «очередь занята» с Retry-After: 1. */
    busyBulk(n: number) { bulkBusy = n; },
    /** Выписка обязанностей инструкции «зависла»: pending остался, а задачи нет (API перезапускался). */
    stallDuties(nodeId: string) {
      const n = nodes.get(nodeId);
      if (!n) return;
      Object.assign(n.props, { dutiesStatus: "pending", dutiesError: null });
      stalled.add(nodeId);
    },
    /** headers — заголовки запроса: по Authorization определяется, кто спрашивает;
        без него — options.user (вызовы из самих тестов). */
    handle(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Reply {
      const parsed = new URL(url, "http://mock");
      if (parsed.pathname.startsWith("/idp/")) return idpRoute(method.toUpperCase(), parsed.pathname, parsed.searchParams, body);
      const header = (name: string) => Object.entries(headers).find(([k]) => k.toLowerCase() === name)?.[1];
      const auth = header("authorization");
      // Запрос из браузера (заголовки есть) без токена — как у настоящего API: 401.
      // Вызовы из самих тестов заголовков не передают и идут от имени options.user.
      const fromBrowser = Object.keys(headers).length > 0;
      if (fromBrowser && auth === undefined && !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())
        && header("x-requested-with") !== "XMLHttpRequest")
        return { status: 403, body: { detail: "Запрос отклонён: нет заголовка X-Requested-With" } };
      if (auth === undefined) current = fromBrowser ? null : options.user ?? null;
      else {
        const token = auth.replace(/^Bearer\s+/i, "");
        current = !revoked && token.startsWith(TOKEN_PREFIX) ? token.slice(TOKEN_PREFIX.length) : null;
      }
      try {
        const result = route(method.toUpperCase(), parsed.pathname, parsed.searchParams, body);
        if (parsed.pathname === "/auth/logout") return { status: 204, body: null };
        if (result instanceof Accepted) return { status: 202, body: result.body };
        return { status: method.toUpperCase() === "POST"
          && /^\/(catalog\/(orders|clauses|rules|examples|check-targets|departments|job-descriptions)|auth\/users|settings\/api-keys)$/
            .test(parsed.pathname) ? 201 : 200, body: result };
      } catch (err) {
        if (err instanceof HttpError) return { status: err.status, body: { detail: err.message }, headers: err.headers };
        return { status: 500, body: { detail: String(err) } };
      }
    },
  };
}
