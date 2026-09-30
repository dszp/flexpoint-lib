/**
 * Shared test helpers: a recording mock `fetch` that speaks FlexPoint's shapes, including the
 * login exchange and the `record-count` header.
 *
 * Build-excluded and never exported from the barrel, but type-checked by `tsconfig.test.json`.
 * Node-free like the rest of the source. Every value here is fictional.
 */

export interface RecordedCall {
  method: string;
  url: string;
  /** Path + query relative to the origin, for terse assertions. */
  target: string;
  headers: Record<string, string>;
  body?: string;
}

export interface MockResponse {
  status?: number;
  /** JSON body, serialised with `JSON.stringify`. */
  body?: unknown;
  /** Exact body text, for int64 literals `JSON.stringify` cannot produce and for non-JSON errors. */
  rawBody?: string;
  headers?: Record<string, string>;
}

export interface MockFetchOptions {
  /** Answer for a non-login call. */
  handler?: (call: RecordedCall) => MockResponse | undefined;
  /** Tokens handed out by successive logins. Defaults to one token that never expires. */
  tokens?: string[];
  /** Tokens the API accepts. Defaults to every token in `tokens`. */
  validTokens?: () => string[];
}

export interface MockFetch {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
  /** Calls excluding the login exchange. */
  apiCalls: () => RecordedCall[];
  logins: () => number;
}

export const TEST_SECRET = 'test-secret-not-real';
export const TEST_BASE = 'https://flexpoint.example.com/core-api';

/** A syntactically valid unsigned JWT whose `exp` is `expSeconds`. */
export function fakeJwt(expSeconds: number, sub = 'merchant-0'): string {
  const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub, iat: expSeconds - 1800, exp: expSeconds })}.sig`;
}

function toResponse(spec: MockResponse): Response {
  const status = spec.status ?? 200;
  const text = spec.rawBody ?? (spec.body === undefined ? '' : JSON.stringify(spec.body));
  return new Response(status === 204 ? null : text, {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(spec.headers ?? {}) },
  });
}

export function mockFetch(opts: MockFetchOptions = {}): MockFetch {
  const calls: RecordedCall[] = [];
  const tokens = [...(opts.tokens ?? ['tok-1'])];
  const issued: string[] = [];
  const valid = opts.validTokens ?? (() => opts.tokens ?? ['tok-1']);

  const fetchImpl = (async (input: any, init: any = {}) => {
    const url = String(input);
    const u = new URL(url);
    const call: RecordedCall = {
      method: init.method ?? 'GET',
      url,
      target: u.pathname.replace(/^\/core-api/, '') + u.search,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body,
    };
    calls.push(call);

    if (call.target === '/api/v1/auth/login-merchant') {
      const { secret } = JSON.parse(call.body ?? '{}') as { secret?: string };
      if (secret !== TEST_SECRET) return toResponse({ status: 400, body: 'Bad credentials' });
      const token = tokens.shift() ?? issued[issued.length - 1] ?? 'tok-1';
      issued.push(token);
      return toResponse({ body: { token } });
    }

    const auth = call.headers.Authorization ?? '';
    if (!valid().includes(auth.replace(/^Bearer /, ''))) {
      return toResponse({ status: 401, rawBody: '', headers: { 'www-authenticate': 'Bearer error="invalid_token"' } });
    }
    return toResponse(opts.handler?.(call) ?? { status: 404, rawBody: '' });
  }) as unknown as typeof fetch;

  return {
    fetchImpl,
    calls,
    apiCalls: () => calls.filter((c) => !c.target.startsWith('/api/v1/auth/')),
    logins: () => calls.filter((c) => c.target.startsWith('/api/v1/auth/')).length,
  };
}

/** Deterministic int64 ids above `Number.MAX_SAFE_INTEGER`, as FlexPoint issues them. */
export function bigId(n: number): string {
  return `9000000000000${String(n).padStart(5, '0')}`;
}

export function fakeDeposit(n: number) {
  return { payoutId: bigId(n), amount: 100 + n, datePaid: '2026-01-01T12:00:00' };
}

/**
 * Serve an offset-paginated list the way FlexPoint does: a bare JSON array with a `record-count`
 * header, `offset` counting rows. Ids are emitted as bare int64 literals, like the real API.
 */
export function pagedHandler(pathSuffix: string, rows: Array<Record<string, unknown>>, extraHeaders: Record<string, string> = {}) {
  return (call: RecordedCall): MockResponse | undefined => {
    const u = new URL(call.url);
    if (!u.pathname.endsWith(pathSuffix)) return undefined;
    const size = Number(u.searchParams.get('page_size') ?? 50);
    const offset = Number(u.searchParams.get('offset') ?? 0);
    const page = rows.slice(offset, offset + size);
    return { rawBody: int64Json(page), headers: { 'record-count': String(rows.length), ...extraHeaders } };
  };
}

/** `JSON.stringify`, but values of `*Id` keys holding digit strings are written as bare numbers. */
export function int64Json(value: unknown): string {
  return JSON.stringify(value).replace(/"(\w*Id)":"(\d+)"/g, '"$1":$2');
}
