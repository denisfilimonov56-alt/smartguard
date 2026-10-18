/* Вход через Keycloak: OpenID Connect, authorization code + PKCE, без библиотек.

   Интерфейс — публичный клиент: секрета у него нет, вместо него PKCE.
   Пароль пользователь вводит на странице Keycloak, сюда он не попадает.
   Keycloak возвращает на страницу с кодом, код меняется на токены прямо
   отсюда (fetch в Keycloak — его адрес разрешён в CSP), и дальше каждый
   запрос к API несёт access-токен в заголовке Authorization.

   Токены лежат в sessionStorage: переживают перезагрузку страницы, но не
   закрытие вкладки, и другой вкладке не видны. Истёкший access-токен
   обновляется refresh-токеном незаметно (а пока пользователь работает —
   заранее, см. state/auth.tsx); если и он не годится (сессию закрыли в
   Keycloak), интерфейс предлагает войти снова, сохранив черновики форм.

   Откуда брать Keycloak, сообщает API: GET /auth/config → издатель и
   клиент, дальше — стандартный документ .well-known издателя. */

const TOKENS_KEY = "gc.oidc";
const PENDING_KEY = "gc.oidc.pending";
/* За сколько секунд до истечения access-токен считается просроченным:
   запрос ещё должен успеть дойти до API. */
const EXPIRY_MARGIN = 30;
/* Сколько ждать ответа Keycloak (и /auth/config): зависший сервис входа
   не должен держать экран в «Загрузка…» бесконечно. */
const OIDC_TIMEOUT_MS = 15_000;

export interface Tokens {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  /** Unix-время в миллисекундах, после которого access-токен недействителен. */
  expiresAt: number;
}

interface Provider {
  issuer: string;
  clientId: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  endSessionEndpoint: string | null;
}

/** Вход не состоялся или прервался: показать пользователю, предложить войти снова.
    offline — сервис входа недоступен (сеть, 5xx, 429, оборванный ответ): токены не стирать.
    status и code — код ответа и поле error из тела, если ответ был. */
export class OidcError extends Error {
  constructor(message: string, readonly offline = false, readonly status = 0, readonly code = "") {
    super(message);
  }
}

/* Keycloak отказал в обновлении по существу: refresh-токен истёк, сессию закрыли
   (400 invalid_grant) или клиент не узнан (401). Только это — «сессия закрыта»;
   429 и 408 от прокси, прочие 4xx — временная недоступность сервиса входа. */
const rejected = (err: OidcError) => err.status === 401 || (err.status === 400 && err.code === "invalid_grant");

/* Куда вернуть пользователя после входа. Адрес разделов — свой у каждого
   (/check, /rules, …), поэтому после Keycloak он открывается заново. */
const redirectUri = () => location.origin + "/";

function read<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown) {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch { /* приватное окно без хранилища: вход проживёт до перезагрузки */ }
}

let memory: Tokens | null = null;
const tokens = () => memory ?? (memory = read<Tokens>(TOKENS_KEY));
function keep(next: Tokens | null) {
  memory = next;
  write(TOKENS_KEY, next);
}

/** Забыть токены на этой вкладке, не трогая сессию Keycloak (её закрывает logout). */
export const clear = () => keep(null);

// ----------------------------------------------------------------------------
//  Провайдер
// ----------------------------------------------------------------------------

let providerPromise: Promise<Provider> | null = null;

async function fetchJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OIDC_TIMEOUT_MS);
  let response: Response;
  let text: string;
  try {
    response = await fetch(url, { ...init, signal: controller.signal });
    // Тело — под тем же пределом: оборвавшийся ответ — недоступность, а не пустой ответ.
    text = await response.text();
  } catch {
    throw new OidcError("Сервис входа недоступен", true);
  } finally {
    clearTimeout(timer);
  }
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = text.trim() ? JSON.parse(text) : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
    else if (response.ok) throw new Error("не объект");
  } catch {
    // Успешный ответ без разборчивого JSON — сбой сервиса или прокси перед ним.
    if (response.ok) throw new OidcError("Сервис входа вернул неразборчивый ответ", true, response.status);
  }
  if (!response.ok) {
    const detail = payload.detail ?? payload.error_description ?? payload.error;
    const code = typeof payload.error === "string" ? payload.error : "";
    const message = typeof detail === "string" ? detail : `Сервис входа ответил ${response.status}`;
    // Отказ по существу — только 400/401 (неверный код, истёкший refresh); остальное временно.
    const offline = response.status !== 400 && response.status !== 401;
    throw new OidcError(message, offline, response.status, code);
  }
  return payload;
}

/** Издатель и клиент — от API, адреса конечных точек — из документа издателя. Кэшируется на страницу. */
function provider(): Promise<Provider> {
  providerPromise ??= (async () => {
    const config = await fetchJson("/api/auth/config", { headers: { "X-Requested-With": "XMLHttpRequest" } });
    const issuer = String(config.issuer ?? "").replace(/\/+$/, "");
    const clientId = String(config.clientId ?? "");
    if (!issuer || !clientId) throw new OidcError("Сервис входа не настроен на сервере", true);
    const doc = await fetchJson(issuer + "/.well-known/openid-configuration");
    const endpoint = (name: string) => {
      const value = doc[name];
      if (typeof value !== "string" || !value) throw new OidcError(`Сервис входа не сообщил ${name}`, true);
      return value;
    };
    return {
      issuer, clientId,
      authorizationEndpoint: endpoint("authorization_endpoint"),
      tokenEndpoint: endpoint("token_endpoint"),
      endSessionEndpoint: typeof doc.end_session_endpoint === "string" ? doc.end_session_endpoint : null,
    };
  })().catch((err) => { providerPromise = null; throw err; });
  return providerPromise;
}

// ----------------------------------------------------------------------------
//  PKCE
// ----------------------------------------------------------------------------

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function random(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/* SHA-256 для PKCE. crypto.subtle есть только в безопасном контексте
   (HTTPS или localhost); стенд открывают и по HTTP с другого компьютера,
   поэтому на такой случай — та же функция на чистом JS (FIPS 180-4). */
async function sha256(text: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(text);
  if (globalThis.crypto?.subtle) return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return sha256js(data);
}

function sha256js(message: Uint8Array): Uint8Array {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const length = message.length;
  const padded = new Uint8Array(Math.ceil((length + 9) / 64) * 64);
  padded.set(message);
  padded[length] = 0x80;
  new DataView(padded.buffer).setUint32(padded.length - 4, length * 8, false);
  const view = new DataView(padded.buffer);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  const out = new Uint8Array(32);
  new DataView(out.buffer).setUint32(0, H[0]); new DataView(out.buffer).setUint32(4, H[1]);
  new DataView(out.buffer).setUint32(8, H[2]); new DataView(out.buffer).setUint32(12, H[3]);
  new DataView(out.buffer).setUint32(16, H[4]); new DataView(out.buffer).setUint32(20, H[5]);
  new DataView(out.buffer).setUint32(24, H[6]); new DataView(out.buffer).setUint32(28, H[7]);
  return out;
}

// ----------------------------------------------------------------------------
//  Токены
// ----------------------------------------------------------------------------

interface Pending {
  state: string;
  verifier: string;
  /** Раздел, с которого ушли на вход: туда и вернуться. */
  returnTo: string;
}

async function tokenRequest(form: Record<string, string>): Promise<Tokens> {
  const { tokenEndpoint, clientId } = await provider();
  const payload = await fetchJson(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...form, client_id: clientId }).toString(),
  });
  const accessToken = payload.access_token;
  if (typeof accessToken !== "string" || !accessToken) throw new OidcError("Сервис входа не выдал токен", true);
  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 300;
  return {
    accessToken,
    refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token : null,
    idToken: typeof payload.id_token === "string" ? payload.id_token : null,
    expiresAt: Date.now() + expiresIn * 1000,
  };
}

const fresh = (t: Tokens) => t.expiresAt - EXPIRY_MARGIN * 1000 > Date.now();

let refreshing: Promise<Tokens | null> | null = null;

/** Обновить токены refresh-токеном; null — сессии в Keycloak больше нет. Параллельные вызовы ждут один запрос. */
function refresh(current: Tokens): Promise<Tokens | null> {
  if (!current.refreshToken) return Promise.resolve(null);
  const token = current.refreshToken;
  // Сброс — в .finally промиса, а не в finally внутри: тот мог бы сработать раньше присваивания.
  refreshing ??= (async () => {
    try {
      const next = await tokenRequest({ grant_type: "refresh_token", refresh_token: token });
      keep(next);
      return next;
    } catch (err) {
      // Keycloak отказал по существу (400 invalid_grant, 401) — выход. Сеть упала, Keycloak
      // не ответил или ответил иначе (429, 408, прочие 4xx) — токены оставляем и при
      // следующем запросе пробуем снова: пока access-токен ещё действует, идём с ним, а истёкший слать незачем — API ответит 401, и интерфейс
      // решит, что сессия закончилась, хотя она жива.
      if (err instanceof OidcError && rejected(err)) {
        keep(null);
        return null;
      }
      if (current.expiresAt > Date.now()) return current;
      throw err instanceof OidcError && err.offline ? err
        : new OidcError(err instanceof OidcError ? err.message : "Сервис входа недоступен", true);
    }
  })().finally(() => { refreshing = null; });
  return refreshing;
}

/** Действующий access-токен для запроса к API; null — не вошли.
    Бросает OidcError (offline), если токен истёк, а Keycloak недоступен. */
export async function accessToken(): Promise<string | null> {
  const current = tokens();
  if (!current) return null;
  if (fresh(current)) return current.accessToken;
  return (await refresh(current))?.accessToken ?? null;
}

/** Есть ли вообще токены на этой вкладке (действующие или нет). */
export const hasSession = () => tokens() !== null;

/** Когда истекает access-токен (Unix-время, мс); null — токенов нет. */
export const expiresAt = () => tokens()?.expiresAt ?? null;

/** Продлить сессию заранее, не дожидаясь запроса. false — сессии в Keycloak больше нет;
    true — продлили или Keycloak сейчас недоступен (попробуем позже). */
export async function extend(): Promise<boolean> {
  const current = tokens();
  if (!current) return false;
  try {
    return (await refresh(current)) !== null;
  } catch {
    return true;
  }
}

/* Параметры, с которыми Keycloak возвращает на redirect_uri. */
const CALLBACK_PARAMS = ["code", "state", "session_state", "iss", "error", "error_description", "error_uri"];

/** Свой текст по коду ошибки Keycloak: error_description из адреса не показываем — его мог подставить кто угодно. */
function errorMessage(code: string): string {
  switch (code) {
    case "access_denied": return "Вход отменён или отклонён сервисом входа";
    case "login_required":
    case "interaction_required": return "Нужно войти заново";
    case "temporarily_unavailable":
    case "server_error": return "Сервис входа временно недоступен, попробуйте позже";
    default: return `Вход не выполнен (${/^[a-z_]{1,40}$/.test(code) ? code : "ошибка сервиса входа"})`;
  }
}

/** Разобрать возврат из Keycloak или поднять сохранённые токены. null — входа нет.

    Бросает OidcError, если вход начался, но не завершился: тогда показать
    сообщение и предложить войти снова. */
export async function restore(): Promise<Tokens | null> {
  const url = new URL(location.href);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  if (code || error) {
    const pending = read<Pending>(PENDING_KEY);
    if (!pending || !state || pending.state !== state) {
      // Возврат не с нашего входа (чужая ссылка, старая вкладка): ничего не разбираем
      // и не показываем, только убираем параметры из адреса.
      for (const name of CALLBACK_PARAMS) url.searchParams.delete(name);
      history.replaceState(null, "", url.pathname + url.search + url.hash);
    } else {
      write(PENDING_KEY, null);
      // Адрес с кодом одноразовый: в истории и закладках ему не место.
      history.replaceState(null, "", pending.returnTo || "/");
      if (error) throw new OidcError(errorMessage(error));
      if (!code) throw new OidcError("Вход не подтверждён: попробуйте ещё раз");
      return await exchange(code, pending);
    }
  }
  const current = tokens();
  if (!current) return null;
  return fresh(current) ? current : refresh(current);
}

/** Обменять одноразовый код на токены (PKCE: verifier из начала входа). */
async function exchange(code: string, pending: Pending): Promise<Tokens> {
  const next = await tokenRequest({
    grant_type: "authorization_code", code, redirect_uri: redirectUri(), code_verifier: pending.verifier,
  });
  keep(next);
  return next;
}

/** Уйти на страницу входа Keycloak. Сюда вернёмся с кодом — см. restore(). */
export async function login(): Promise<void> {
  const { authorizationEndpoint, clientId } = await provider();
  const verifier = random(48);
  const state = random(24);
  const challenge = base64url(await sha256(verifier));
  write(PENDING_KEY, { state, verifier, returnTo: location.pathname + location.search } satisfies Pending);
  const params = new URLSearchParams({
    client_id: clientId, response_type: "code", scope: "openid profile",
    redirect_uri: redirectUri(), state, code_challenge: challenge, code_challenge_method: "S256",
  });
  location.assign(`${authorizationEndpoint}?${params}`);
}

/** Закрыть сессию в Keycloak и вернуться на экран входа. Если Keycloak недоступен — просто забыть токены. */
export async function logout(): Promise<void> {
  const current = tokens();
  keep(null);
  let target = "/";
  try {
    const { endSessionEndpoint, clientId } = await provider();
    if (endSessionEndpoint) {
      const params = new URLSearchParams({ client_id: clientId, post_logout_redirect_uri: redirectUri() });
      if (current?.idToken) params.set("id_token_hint", current.idToken);
      target = `${endSessionEndpoint}?${params}`;
    }
  } catch { /* сессия Keycloak закроется по своему таймауту */ }
  location.assign(target);
}
