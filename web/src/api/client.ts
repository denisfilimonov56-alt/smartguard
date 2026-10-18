import type {
  ApiKey, ApiKeyCreated, CacheCleared, CacheId, CacheStats, Settings,
  CheckMode, CheckRecord, GraphEdge, GraphNode, MonitoringNow, MonitoringStats, StatsStep,
  Account, Advice, BatchCheck, CheckResult, GoalItem, CheckTarget, Department, Descendants, Diagnostics, ExamplesCheck, FlatClause,
  MergeReport, NodeProps, Order, RepairReport, Role, RuleType, Status, TargetSource, User, UserStatus,
} from "./types";
import * as oidc from "../lib/oidc";

/* API всегда на том же origin, под /api: в сборке его проксирует nginx
   интерфейса, в разработке — Vite (прокси или фейк, см. vite.config.ts).
   Адрес намеренно нельзя переопределить из строки запроса: иначе ссылка
   вида ?api=https://чужой-сервер получала бы токен пользователя. */
export const API_BASE = "/api";

export class ApiError extends Error {
  /** retryAfter — через сколько секунд повторить (заголовок Retry-After у 503 и 429); null — не сказано. */
  constructor(message: string, readonly status: number, readonly retryAfter: number | null = null) {
    super(message);
  }
}

/** Retry-After в секундах: число или HTTP-дата; null — заголовка нет или он непонятен. */
function retryAfterOf(response: Response): number | null {
  const raw = response.headers.get("Retry-After")?.trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/* Токен могли отозвать посреди работы: любой ответ 401 предлагает войти снова
   (state/auth.tsx). Обработчик получает detail ответа и признак действия
   пользователя: изменяющий запрос (не GET) — всегда его действие, GET может
   быть и фоновым опросом. */
type SessionLostHandler = (detail: string, userAction: boolean) => void;
let onSessionLost: SessionLostHandler | null = null;
export const setSessionLostHandler = (handler: SessionLostHandler | null) => { onSessionLost = handler; };
/* 401 от них — не «сессия закончилась посреди работы»: /auth/me разбирает сам
   вход (state/auth.tsx), а выход и так уходит на экран входа. */
const NOT_SESSION_LOSS = new Set(["/auth/me", "/auth/logout"]);

/** Отмена и предел ожидания запроса. */
export interface RequestOptions {
  /** Отмена вызывающим (например, кнопка «Остановить» у пакета). */
  signal?: AbortSignal;
  /** Сколько ждать ответа, мс; по умолчанию READ_TIMEOUT_MS или WRITE_TIMEOUT_MS.
      Пока тело ответа приходит, предел отсчитывается от последнего пришедшего куска. */
  timeoutMs?: number;
}

/* Без предела зависший API или прокси держит интерфейс в «Загрузка…» бесконечно. */
export const READ_TIMEOUT_MS = 30_000;
export const WRITE_TIMEOUT_MS = 120_000;
/* Проверка идёт через модель; nginx интерфейса ждёт API до 600 с. */
export const CHECK_TIMEOUT_MS = 610_000;
/* Тяжёлые чтения: разбор всего каталога, граф, сводка и история мониторинга
   за длинный период считаются на сервере дольше обычного GET. */
export const SLOW_READ_TIMEOUT_MS = 180_000;

/** Сигнал, который срабатывает и по отмене вызывающим, и по таймауту.
    restart() заводит таймер заново: пока тело ответа приходит кусками, предел
    отсчитывается от последнего куска, а не от начала запроса. */
function withTimeout(signal: AbortSignal | undefined, ms: number):
    { signal: AbortSignal; timedOut: () => boolean; restart: () => void; done: () => void } {
  const controller = new AbortController();
  let expired = false;
  const expire = () => { expired = true; controller.abort(); };
  let timer = setTimeout(expire, ms);
  const cancel = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", cancel, { once: true });
  const restart = () => { clearTimeout(timer); timer = setTimeout(expire, ms); };
  const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); };
  return { signal: controller.signal, timedOut: () => expired, restart, done };
}

/** Прочитать тело ответа целиком; каждый пришедший кусок продлевает предел ожидания. */
async function readBody(response: Response, onChunk: () => void): Promise<string> {
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onChunk();
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** Запрос отменён вызывающим: не ошибка для пользователя. */
export const isAborted = (e: unknown) => e instanceof ApiError && e.status === -1;

async function request<T>(method: Method, path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
  // Токен Keycloak обновляется по пути, если истёк; без него запрос уйдёт
  // без заголовка и получит 401 — это и есть «сессия закончилась».
  let token: string | null;
  try {
    token = await oidc.accessToken();
  } catch (err) {
    // Токен истёк, а Keycloak не ответил: токены не стираем, следующий запрос попробует снова.
    if (err instanceof oidc.OidcError) throw new ApiError(err.message, 0);
    throw err;
  }
  const limit = withTimeout(options.signal, options.timeoutMs ?? (method === "GET" ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS));
  let response: Response;
  try {
    response = await fetch(API_BASE + path, {
      method,
      signal: limit.signal,
      // X-Requested-With API требует у изменяющих запросов: чужая страница
      // такой заголовок поставить не может.
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        ...(token ? { Authorization: "Bearer " + token } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    limit.done();
    if (limit.timedOut()) throw new ApiError("API не ответил вовремя", 0);
    if (options.signal?.aborted) throw new ApiError("Запрос отменён", -1);
    throw new ApiError("API недоступен", 0);
  }
  // Тело читается под тем же пределом: оборванный ответ (таймаут, отмена,
  // разрыв связи) — ошибка, а не «пустой ответ», иначе при 200 вызывающий
  // получил бы null вместо данных.
  let text: string;
  try {
    text = await readBody(response, limit.restart);
  } catch {
    if (limit.timedOut()) throw new ApiError("API не ответил вовремя", 0);
    if (options.signal?.aborted) throw new ApiError("Запрос отменён", -1);
    throw new ApiError("Ответ API оборвался", 0);
  } finally {
    limit.done();
  }
  // null — только когда тело действительно пустое (204, DELETE без ответа).
  let payload: unknown = null;
  if (text.trim()) {
    try {
      payload = JSON.parse(text);
    } catch {
      // Страница ошибки прокси (502 от nginx) — не JSON: для ошибки хватит кода.
      if (response.ok) throw new ApiError("API вернул неразборчивый ответ", 0);
    }
  }

  if (!response.ok) {
    const detail = (payload as { detail?: unknown } | null)?.detail;
    const message = typeof detail === "string" ? detail
      : Array.isArray(detail) ? detail.map((d) => d?.msg ?? JSON.stringify(d)).join("; ")
      : `HTTP ${response.status}`;
    if (response.status === 401 && !NOT_SESSION_LOSS.has(path)) onSessionLost?.(message, method !== "GET");
    throw new ApiError(message, response.status, retryAfterOf(response));
  }
  return payload as T;
}

/** Ответ создания узла: его свойства и nodeId. */
export interface Created {
  nodeId: string;
  [key: string]: unknown;
}

/** Инструкция после загрузки или правки: список обязанностей, выписанный моделью. */
export interface JobDescriptionNode extends Created {
  title?: string;
  duties?: string[];
  /** Почему обязанности не выписаны (модель не ответила); иначе null. */
  dutiesError?: string | null;
  /** Выписка обязанностей идёт в фоне: pending — ещё идёт, ready — готово, error — см. dutiesError. */
  dutiesStatus?: "pending" | "ready" | "error" | null;
}

const enc = encodeURIComponent;
const node = (id: string) => `/catalog/nodes/${enc(id)}`;

/** Период отбора истории: start включительно, end — нет; ISO 8601. */
export interface Period {
  start: string;
  end: string;
  mode?: CheckMode | "";
}
const period = (p: Period) => `start=${enc(p.start)}&end=${enc(p.end)}${p.mode ? `&mode=${p.mode}` : ""}`;

export const api = {
  me: () => request<Account>("GET", "/auth/me"),
  /** Отметка выхода в журнале API; саму сессию закрывает Keycloak (lib/oidc.ts). */
  logout: () => request<null>("POST", "/auth/logout"),
  /** Обучение по интерфейсу пройдено или пропущено: при следующем входе не показывать. */
  markTourSeen: () => request<{ tourSeenAt: string }>("POST", "/auth/me/tour"),
  users: () => request<{ users: User[] }>("GET", "/auth/users"),
  createUser: (body: { login: string; role: Role; displayName: string | null }) =>
    request<User>("POST", "/auth/users", body),
  patchUser: (login: string, body: { role?: Role; status?: UserStatus; displayName?: string | null }) =>
    request<User>("PATCH", `/auth/users/${enc(login)}`, body),
  deleteUser: (login: string) => request("DELETE", `/auth/users/${enc(login)}`),
  unbindUser: (login: string) => request<User>("DELETE", `/auth/users/${enc(login)}/binding`),

  tree: (includeArchived: boolean) =>
    request<{ orders: Order[] }>("GET", `/catalog/tree?include_archived=${includeArchived}`),
  checkTargets: (includeArchived: boolean) =>
    request<{ targets: CheckTarget[] }>("GET", `/catalog/check-targets?include_archived=${includeArchived}`),
  clauses: () => request<{ clauses: FlatClause[] }>("GET", "/catalog/clauses"),
  departments: (includeArchived: boolean) =>
    request<{ departments: Department[] }>("GET", `/catalog/departments?include_archived=${includeArchived}`),
  diagnostics: () => request<Diagnostics>("GET", "/catalog/diagnostics", undefined, { timeoutMs: SLOW_READ_TIMEOUT_MS }),
  examplesCheck: () => request<ExamplesCheck>("GET", "/catalog/examples-check"),
  startExamplesCheck: () => request<ExamplesCheck>("POST", "/catalog/examples-check"),
  advice: (body: { goal: string; attribute: string; expected: boolean; reason: string; department_id: string | null }) =>
    request<Advice>("POST", "/catalog/advice", body, { timeoutMs: CHECK_TIMEOUT_MS }),
  graph: () => request<{ nodes: GraphNode[]; edges: GraphEdge[] }>("GET", "/catalog/graph", undefined,
    { timeoutMs: SLOW_READ_TIMEOUT_MS }),

  monitoringNow: () => request<MonitoringNow>("GET", "/monitoring/now"),
  monitoringStats: (p: Period, step: StatsStep, timezone: string) =>
    request<MonitoringStats>("GET", `/monitoring/stats?${period(p)}&step=${step}&timezone=${enc(timezone)}`,
      undefined, { timeoutMs: SLOW_READ_TIMEOUT_MS }),
  monitoringHistory: (p: Period, limit: number, offset: number) =>
    request<{ records: CheckRecord[]; total: number }>(
      "GET", `/monitoring/history?${period(p)}&limit=${limit}&offset=${offset}`,
      undefined, { timeoutMs: SLOW_READ_TIMEOUT_MS }),

  settings: () => request<Settings>("GET", "/settings"),
  saveSettings: (changes: Partial<Settings>) => request<Settings>("PUT", "/settings", changes),
  caches: () => request<{ caches: CacheStats[] }>("GET", "/settings/caches"),
  clearCache: (id: CacheId, departmentId?: string) =>
    request<CacheCleared>("POST", `/settings/caches/${id}/clear`, departmentId ? { departmentId } : {}),
  apiKeys: () => request<{ keys: ApiKey[] }>("GET", "/settings/api-keys"),
  createApiKey: (name: string) => request<ApiKeyCreated>("POST", "/settings/api-keys", { name }),
  deleteApiKey: (keyId: string) => request("DELETE", `/settings/api-keys/${enc(keyId)}`),

  node: (id: string) => request<NodeProps>("GET", node(id)),
  patch: (id: string, properties: Record<string, unknown>) =>
    request<NodeProps>("PATCH", `${node(id)}/properties`, { properties }),
  setStatus: (id: string, status: Status) => request("POST", `${node(id)}/status`, { status }),
  descendants: (id: string) => request<Descendants>("GET", `${node(id)}/descendants`),
  remove: (id: string, force = false) => request("DELETE", node(id) + (force ? "?force=true" : "")),

  createOrder: (body: { number: string; title: string; date: string | null; orderId: string | null }) =>
    request<Created>("POST", "/catalog/orders", body),
  createClause: (body: { orderNodeId: string; code: string; text: string }) =>
    request<Created>("POST", "/catalog/clauses", body),
  createRule: (body: {
    clauseNodeId: string; type: RuleType; description: string; checkInstruction: string; targets: string[];
    studentsOnly?: boolean;
    /** departmentId: правило действует только в них; пусто — во всех. */
    only?: string[];
  }) => request<Created>("POST", "/catalog/rules", body),
  createExample: (body: { ruleNodeId: string; text: string; isViolation: boolean }) =>
    request<Created>("POST", "/catalog/examples", body),
  createTarget: (body: { name: string; description: string; source?: TargetSource | null }) =>
    request<Created>("POST", "/catalog/check-targets", body),
  createJobDescription: (body: { departmentNodeId: string; title: string; text: string }) =>
    request<JobDescriptionNode>("POST", "/catalog/job-descriptions", body),
  updateJobDescription: (id: string, body: { title: string; text: string }) =>
    request<JobDescriptionNode>("PUT", `/catalog/job-descriptions/${enc(id)}`, body),
  extractJobDuties: (id: string) =>
    request<JobDescriptionNode>("POST", `/catalog/job-descriptions/${enc(id)}/extract-duties`),
  /** Опрос фоновой выписки обязанностей. */
  jobDescription: (id: string) => request<JobDescriptionNode>("GET", `/catalog/job-descriptions/${enc(id)}`),
  setJobDuties: (id: string, duties: string[]) =>
    request<JobDescriptionNode>("PUT", `/catalog/job-descriptions/${enc(id)}/duties`, { duties }),

  createDepartment: (body: { departmentId: string; name: string }) =>
    request<Created>("POST", "/catalog/departments", body),

  setRuleScope: (id: string, only: string[]) =>
    request("PUT", `/catalog/rules/${enc(id)}/departments`, { only }),
  /** Для кого действует правило: только для студентов или для всех. */
  setRuleAudience: (id: string, studentsOnly: boolean) =>
    request("PUT", `/catalog/rules/${enc(id)}/audience`, { studentsOnly }),
  setRuleTargets: (id: string, targets: string[]) =>
    request("PUT", `/catalog/rules/${enc(id)}/targets`, { targets }),
  setReferences: (id: string, references: string[]) =>
    request("PUT", `/catalog/clauses/${enc(id)}/references`, { references }),
  moveClause: (id: string, parentNodeId: string) =>
    request("POST", `/catalog/clauses/${enc(id)}/move`, { parentNodeId }),
  moveRule: (id: string, parentNodeId: string) =>
    request("POST", `/catalog/rules/${enc(id)}/move`, { parentNodeId }),
  repairIdentifiers: () => request<RepairReport>("POST", "/catalog/repair-identifiers"),
  /** Свести двойников атрибутов (одинаковые после нормализации написания). */
  mergeDuplicateTargets: () => request<MergeReport>("POST", "/catalog/merge-duplicate-targets"),

  checkGoal: (goal: string, departmentId: string | null, isStudent: boolean, signal?: AbortSignal) =>
    request<CheckResult>("POST", "/check-goal", { goal, department_id: departmentId, is_student: isStudent },
      { signal, timeoutMs: CHECK_TIMEOUT_MS }),
  /** Пакетная проверка: подразделение у каждой цели обязательно. */
  checkGoals: (items: GoalItem[], signal?: AbortSignal) =>
    request<BatchCheck>("POST", "/check-goals", items, { signal, timeoutMs: CHECK_TIMEOUT_MS }),
};
