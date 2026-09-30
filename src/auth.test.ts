import { describe, it, expect } from 'vitest';
import { FlexPointReadClient } from './readClient.js';
import { FlexPointApiError } from './errors.js';
import { jwtExpiryMs, loginMerchant } from './auth.js';
import { fakeDeposit, fakeJwt, int64Json, mockFetch, TEST_BASE, TEST_SECRET, type MockFetch } from './testkit.js';

const NOW = 1_800_000_000_000;

function depositHandler() {
  return () => ({ rawBody: int64Json([fakeDeposit(1)]), headers: { 'record-count': '1' } });
}

function client(f: MockFetch, nowMs = () => NOW, secret = TEST_SECRET) {
  return new FlexPointReadClient({ auth: { secret }, baseUrl: TEST_BASE, fetchImpl: f.fetchImpl, nowMs });
}

describe('auth', () => {
  it('logs in once with { secret } and sends the token as a bearer', async () => {
    const tok = fakeJwt(NOW / 1000 + 1800);
    const f = mockFetch({ tokens: [tok], handler: depositHandler() });
    const c = client(f);
    await c.listDeposits();
    await c.listDeposits();
    expect(f.logins()).toBe(1);
    const login = f.calls[0]!;
    expect(login.method).toBe('POST');
    expect(JSON.parse(login.body!)).toEqual({ secret: TEST_SECRET });
    expect(f.apiCalls()[0]!.headers.Authorization).toBe(`Bearer ${tok}`);
  });

  it('shares one in-flight login across concurrent first calls', async () => {
    const f = mockFetch({ tokens: [fakeJwt(NOW / 1000 + 1800)], handler: depositHandler() });
    const c = client(f);
    await Promise.all([c.listDeposits(), c.listDeposits(), c.listDeposits()]);
    expect(f.logins()).toBe(1);
  });

  it('logs in again when the token is within the refresh window of exp', async () => {
    const first = fakeJwt(NOW / 1000 + 1800);
    const second = fakeJwt(NOW / 1000 + 3600);
    const f = mockFetch({ tokens: [first, second], handler: depositHandler() });
    let now = NOW;
    const c = client(f, () => now);
    await c.listDeposits();
    now = NOW + 1800_000 - 30_000; // 30 s before exp: inside the 60 s skew
    await c.listDeposits();
    expect(f.logins()).toBe(2);
    expect(f.apiCalls()[1]!.headers.Authorization).toBe(`Bearer ${second}`);
  });

  it('recovers from a 401 with one fresh login and one retry', async () => {
    const revoked = fakeJwt(NOW / 1000 + 1800, 'a');
    const fresh = fakeJwt(NOW / 1000 + 1800, 'b');
    const f = mockFetch({ tokens: [revoked, fresh], validTokens: () => [fresh], handler: depositHandler() });
    const page = await client(f).listDeposits();
    expect(page.items).toHaveLength(1);
    expect(f.logins()).toBe(2);
    expect(f.apiCalls()).toHaveLength(2);
  });

  it('gives up after one retry when the fresh token is also rejected', async () => {
    const f = mockFetch({ tokens: ['x', 'y'], validTokens: () => [], handler: depositHandler() });
    const err = await client(f).listDeposits().catch((e) => e);
    expect(err).toBeInstanceOf(FlexPointApiError);
    expect(err.status).toBe(401);
    expect(err.message).toMatch(/revoked/);
    expect(f.apiCalls()).toHaveLength(2);
  });

  it('uses a static { token } as-is, never logs in, and says why a 401 is final', async () => {
    const f = mockFetch({ tokens: ['static'], validTokens: () => [], handler: depositHandler() });
    const c = new FlexPointReadClient({ auth: { token: 'static' }, baseUrl: TEST_BASE, fetchImpl: f.fetchImpl });
    const err = await c.listDeposits().catch((e) => e);
    expect(f.logins()).toBe(0);
    expect(err.status).toBe(401);
    expect(err.message).toMatch(/Pass \{ secret \}/);
  });

  it('surfaces a rejected secret as a 400 with a hint and no API call', async () => {
    const f = mockFetch({ handler: depositHandler() });
    const err = await client(f, () => NOW, 'wrong').listDeposits().catch((e) => e);
    expect(err).toBeInstanceOf(FlexPointApiError);
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/Bad credentials.*secret was rejected/);
    expect(f.apiCalls()).toHaveLength(0);
  });

  it('refuses an empty secret and a config with neither secret nor token', async () => {
    await expect(loginMerchant('', { baseUrl: TEST_BASE, fetchImpl: mockFetch().fetchImpl })).rejects.toThrow(/empty/);
    expect(() => new FlexPointReadClient({ auth: {} as any })).toThrow(/secret.*token/);
  });

  it('reads exp from a JWT and tolerates tokens without one', () => {
    expect(jwtExpiryMs(fakeJwt(1_790_800_833))).toBe(1_790_800_833_000);
    expect(jwtExpiryMs('opaque-token')).toBeUndefined();
    expect(jwtExpiryMs('a.!!!.c')).toBeUndefined();
  });
});
