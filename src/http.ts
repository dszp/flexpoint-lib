/**
 * The FlexPoint transport: URL building, bearer auth with one refresh-and-retry on 401, lossless
 * JSON parsing and error normalisation.
 *
 * **Deliberately not exported from the package barrel.** The read-only guarantee of
 * {@link FlexPointReadClient} comes from that class having no mutating method, which only holds
 * while consumers cannot reach the raw transport underneath it. For the same reason this module
 * has no method other than GET; writes will arrive with their own client and their own review.
 */
import { TokenSource, type FlexPointAuth } from './auth.js';
import { FlexPointApiError } from './errors.js';
import { parseFlexPointJson } from './json.js';

/** FlexPoint's production API root. Every route path is relative to it. */
export const DEFAULT_BASE_URL = 'https://apps.getflexpoint.com/core-api';

/** Prefix of the merchant resource routes. */
export const MERCHANT_PREFIX = '/api/merchant/v1';

export interface FlexPointHttpConfig {
  auth: FlexPointAuth;
  /** Defaults to production. Must be HTTPS. */
  baseUrl?: string;
  /**
   * Injectable for tests or a host with its own HTTP primitive (an n8n node can adapt
   * `this.helpers.httpRequest` to this shape). Defaults to the global `fetch`.
   */
  fetchImpl?: typeof fetch;
  /** Injectable clock in epoch ms, for token expiry. Defaults to `Date.now`. */
  nowMs?: () => number;
}

/** Query values the transport serialises. `undefined` entries are dropped. */
export type Query = Record<string, string | number | boolean | undefined>;

export interface ApiResult<T> {
  body: T;
  status: number;
  headers: Headers;
}

/** Plain-language hints for statuses a caller can act on. */
function hint(status: number, path: string, canRefresh: boolean): string {
  switch (status) {
    case 401:
      return canRefresh
        ? 'The token was rejected even after logging in again; the API secret may have been revoked.'
        : 'The bearer token is invalid or expired. Pass { secret } instead so the client can refresh it.';
    case 404:
      return !/\/\d+(?:\/|$)/.test(path)
        ? ''
        : 'No record with that id. Ids are int64: if this one passed through JSON.parse or a Number it was rounded; keep ids as strings.';
    default:
      return '';
  }
}

export class FlexPointHttp {
  readonly #tokens: TokenSource;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(config: FlexPointHttpConfig) {
    const base = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    if (!/^https:\/\//i.test(base)) {
      throw new Error(`FlexPoint baseUrl must be HTTPS, got: ${base}`);
    }
    this.#baseUrl = base;
    // Bind: a bare global `fetch` called as a method of another object throws "Illegal invocation"
    // in Workers and browsers.
    this.#fetch = config.fetchImpl ?? ((input, init) => fetch(input, init));
    this.#tokens = new TokenSource(config.auth, { baseUrl: base, fetchImpl: this.#fetch }, config.nowMs);
  }

  /** Absolute URL for a path plus query, with `undefined` values dropped. */
  buildUrl(path: string, query?: Query): string {
    const url = new URL(`${this.#baseUrl}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  async get<T>(path: string, query?: Query): Promise<ApiResult<T>> {
    const url = this.buildUrl(path, query);
    let res = await this.#send(url, await this.#tokens.get());
    if (res.status === 401 && this.#tokens.canRefresh) {
      // GET is idempotent, so one retry with a fresh login is safe.
      res = await this.#send(url, await this.#tokens.get(true));
    }
    const text = await res.text();

    if (!res.ok) {
      let body: unknown = text;
      try {
        body = text ? JSON.parse(text) : text;
      } catch {
        /* keep raw text */
      }
      const h = hint(res.status, path, this.#tokens.canRefresh);
      throw new FlexPointApiError(
        `FlexPoint GET ${path} -> ${res.status}: ${errorDetail(body) || res.statusText || 'request failed'}${h ? `. ${h}` : ''}`,
        res.status,
        'GET',
        path,
        body,
      );
    }
    return { body: parseFlexPointJson(text) as T, status: res.status, headers: res.headers };
  }

  #send(url: string, token: string): Promise<Response> {
    return this.#fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
    });
  }
}

/** The useful part of FlexPoint's error bodies: `{ Error }`, RFC 9110 problem details, or a bare string. */
function errorDetail(body: unknown): string {
  if (typeof body === 'string') return body;
  if (typeof body !== 'object' || body === null) return '';
  const b = body as { Error?: unknown; title?: unknown; errors?: unknown };
  if (typeof b.Error === 'string') return b.Error;
  if (typeof b.title === 'string') {
    const fields = b.errors && typeof b.errors === 'object' ? ` ${JSON.stringify(b.errors)}` : '';
    return `${b.title}${fields}`;
  }
  return '';
}
