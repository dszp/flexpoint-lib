/**
 * Authentication: exchange the merchant API secret for a short-lived bearer token and keep one
 * fresh.
 *
 * FlexPoint issues an HS256 JWT from `POST /api/v1/auth/login-merchant` with body `{ secret }`.
 * Observed lifetime is 30 minutes. The token's own `exp` claim drives refresh, so a change to the
 * lifetime needs no code change.
 */
import { FlexPointApiError } from './errors.js';

/** The login route, relative to the base URL. */
export const LOGIN_PATH = '/api/v1/auth/login-merchant';

/** Refresh this long before `exp`, so a request never leaves with a token that expires in flight. */
export const REFRESH_SKEW_MS = 60_000;

/**
 * How the client authenticates.
 *
 * - `{ secret }` — the merchant API secret. The client logs in on first use, caches the token, and
 *   logs in again before it expires or when a request comes back 401. Use this.
 * - `{ token }` — a bearer token obtained elsewhere (an n8n credential, another process). Used
 *   as-is and never refreshed; once it expires every call fails with 401.
 */
export type FlexPointAuth = { secret: string; token?: undefined } | { token: string; secret?: undefined };

export interface LoginOptions {
  baseUrl: string;
  fetchImpl: typeof fetch;
}

/** A token plus its expiry in epoch ms, when the JWT carries one. */
export interface IssuedToken {
  token: string;
  expiresAtMs?: number;
}

/** Perform the login exchange once. Most callers want the client, which does this for them. */
export async function loginMerchant(secret: string, opts: LoginOptions): Promise<IssuedToken> {
  if (!secret) throw new Error('FlexPoint login: secret is empty.');
  const res = await opts.fetchImpl(`${opts.baseUrl}${LOGIN_PATH}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret }),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    /* keep raw text */
  }
  if (!res.ok) {
    const detail = typeof body === 'string' && body ? body : res.statusText || 'login failed';
    const hint = res.status === 400 ? ' The API secret was rejected; check it was copied whole and is still active.' : '';
    throw new FlexPointApiError(`FlexPoint POST ${LOGIN_PATH} -> ${res.status}: ${detail}.${hint}`, res.status, 'POST', LOGIN_PATH, body);
  }
  const token = (body as { token?: unknown } | undefined)?.token;
  if (typeof token !== 'string' || !token) {
    throw new FlexPointApiError(`FlexPoint POST ${LOGIN_PATH} -> ${res.status} but no token in the response.`, res.status, 'POST', LOGIN_PATH, body);
  }
  return { token, expiresAtMs: jwtExpiryMs(token) };
}

/** The `exp` claim of a JWT in epoch ms, or `undefined` when it is absent or unreadable. */
export function jwtExpiryMs(token: string): number | undefined {
  const payload = token.split('.')[1];
  if (!payload) return undefined;
  try {
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))) as { exp?: unknown };
    return typeof claims.exp === 'number' ? claims.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Hands out a valid token. Concurrent callers during a login share one in-flight request, so a
 * burst of parallel reads costs one login, not one each.
 */
export class TokenSource {
  #current?: IssuedToken;
  #pending?: Promise<IssuedToken>;

  constructor(
    private readonly auth: FlexPointAuth,
    private readonly login: LoginOptions,
    private readonly nowMs: () => number = Date.now,
  ) {
    if (!auth.secret && !auth.token) throw new Error('FlexPoint auth: provide { secret } or { token }.');
    if (auth.token) this.#current = { token: auth.token };
  }

  /** True when a 401 can be recovered by logging in again. */
  get canRefresh(): boolean {
    return Boolean(this.auth.secret);
  }

  /** A token that is not within {@link REFRESH_SKEW_MS} of expiry. `force` discards the cached one. */
  async get(force = false): Promise<string> {
    if (!this.auth.secret) return this.auth.token!;
    const cur = this.#current;
    const fresh = cur && (cur.expiresAtMs === undefined || cur.expiresAtMs - REFRESH_SKEW_MS > this.nowMs());
    if (!force && fresh) return cur.token;
    this.#pending ??= loginMerchant(this.auth.secret, this.login).finally(() => {
      this.#pending = undefined;
    });
    this.#current = await this.#pending;
    return this.#current.token;
  }
}
