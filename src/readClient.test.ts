import { describe, it, expect } from 'vitest';
import { FlexPointReadClient } from './readClient.js';
import { FlexPointApiError, IncompleteListError } from './errors.js';
import { bigId, fakeDeposit, int64Json, mockFetch, pagedHandler, TEST_BASE, TEST_SECRET, type MockFetch, type RecordedCall } from './testkit.js';
import * as barrel from './index.js';

function client(f: MockFetch) {
  return new FlexPointReadClient({ auth: { secret: TEST_SECRET }, baseUrl: TEST_BASE, fetchImpl: f.fetchImpl });
}

const json = (body: unknown, headers: Record<string, string> = {}) => ({ rawBody: int64Json(body), headers });

describe('FlexPointReadClient', () => {
  it('returns int64 ids exactly and uses them verbatim in the follow-up path', async () => {
    const id = bigId(7);
    const f = mockFetch({
      handler: (c) =>
        c.target === '/api/merchant/v1/Deposits'
          ? json([fakeDeposit(7)], { 'record-count': '1' })
          : c.target === `/api/merchant/v1/Deposits/${id}`
            ? json({ adminFees: 0, payout: { paidAtUtc: '2026-01-01T17:00:00Z', processorPayoutId: 'po_1', payoutBalance: 0, payoutAmount: 107 }, items: [] })
            : undefined,
    });
    const c = client(f);
    const { items } = await c.listDeposits();
    expect(items[0]!.payoutId).toBe(id);
    const detail = await c.getDeposit(items[0]!.payoutId);
    expect(detail.payout.payoutAmount).toBe(107);
  });

  it('refuses a number id before any request, and accepts a bigint', async () => {
    const f = mockFetch({ handler: () => json({ customerId: '5' }) });
    const c = client(f);
    await expect(c.getInvoice(900000000000000123 as any)).rejects.toThrow(/lose precision/);
    await expect(c.getInvoice('12a')).rejects.toThrow(TypeError);
    expect(f.calls).toHaveLength(0);
    await c.getCustomer(5n);
    expect(f.apiCalls()[0]!.target).toBe('/api/merchant/v1/Customers/5');
  });

  it('maps options to the API query names, including metadata[...]', async () => {
    const f = mockFetch({ handler: () => json([], { 'record-count': '0', 'total-amount': '0', 'total-balance': '0' }) });
    const c = client(f);
    await c.listCustomers({ search: 'acme', customerIdParent: bigId(1), addedChilds: true, externalUri: 'crm:9', metadata: { region: 'east' }, offset: 10, pageSize: 20 });
    await c.listInvoices({ search: 'INV-1', metadata: { a: 'b c' } });
    const [cust, inv] = f.apiCalls().map((x) => decodeURIComponent(x.target));
    expect(cust).toBe(
      `/api/merchant/v1/Customers?search=acme&customer_id_parent=${bigId(1)}&added_childs=true&external_uri=crm:9&metadata[region]=east&offset=10&page_size=20`,
    );
    expect(inv).toBe('/api/merchant/v1/Invoices?search=INV-1&metadata[a]=b+c');
  });

  it('rejects paging the API would answer with a 500', async () => {
    const f = mockFetch();
    const c = client(f);
    await expect(c.listDeposits({ pageSize: 0 })).rejects.toThrow(RangeError);
    await expect(c.listDeposits({ offset: -1 })).rejects.toThrow(RangeError);
    await expect(c.listDeposits({ offset: 1.5 })).rejects.toThrow(RangeError);
    expect(f.calls).toHaveLength(0);
  });

  it('reads record-count, total-amount and total-balance from the headers', async () => {
    const f = mockFetch({ handler: () => json([], { 'record-count': '1234', 'total-amount': '98765.43', 'total-balance': '210.5' }) });
    expect(await client(f).listInvoices({ pageSize: 1 })).toEqual({ items: [], recordCount: 1234, totalAmount: 98765.43, totalBalance: 210.5 });
  });

  it('fails loudly when record-count is missing', async () => {
    const f = mockFetch({ handler: () => json([]) });
    await expect(client(f).listDeposits()).rejects.toThrow(/record-count/);
  });

  it('listAllDeposits walks at 500 by row offset and returns exactly record-count rows', async () => {
    const rows = Array.from({ length: 1201 }, (_, i) => fakeDeposit(i));
    const f = mockFetch({ handler: pagedHandler('/Deposits', rows) });
    const out = await client(f).listAllDeposits();
    expect(out).toHaveLength(1201);
    expect(out[1200]!.payoutId).toBe(bigId(1200));
    expect(f.apiCalls().map((c) => c.target)).toEqual([
      '/api/merchant/v1/Deposits?offset=0&page_size=500',
      '/api/merchant/v1/Deposits?offset=500&page_size=500',
      '/api/merchant/v1/Deposits?offset=1000&page_size=500',
    ]);
  });

  it('an exact multiple of the page size stops without an extra empty request', async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => fakeDeposit(i));
    const f = mockFetch({ handler: pagedHandler('/Deposits', rows) });
    expect(await client(f).listAllDeposits()).toHaveLength(1000);
    expect(f.apiCalls()).toHaveLength(2);
  });

  it('passes filters through every page of a walk', async () => {
    const rows = Array.from({ length: 600 }, (_, i) => ({ invoiceId: bigId(i), customerId: '1' }));
    const f = mockFetch({ handler: pagedHandler('/Invoices', rows) });
    await client(f).listAllInvoices({ search: 'x', externalUri: 'crm:1' });
    for (const call of f.apiCalls()) expect(call.target).toContain('search=x&external_uri=crm%3A1');
  });

  it('throws IncompleteListError when a record inserted mid-walk shifts a row onto the next page', async () => {
    let rows = Array.from({ length: 600 }, (_, i) => fakeDeposit(i + 1));
    const serve = pagedHandler('/Deposits', rows);
    const f = mockFetch({
      handler: (call: RecordedCall) => {
        const res = pagedHandler('/Deposits', rows)(call);
        if (call.target.includes('offset=0&')) rows = [fakeDeposit(0), ...rows]; // newest-first insert
        return res ?? serve(call);
      },
    });
    const err = await client(f).listAllDeposits().catch((e) => e);
    expect(err).toBeInstanceOf(IncompleteListError);
    expect(err.duplicates).toBe(1);
  });

  it('turns a 404 into an error that explains int64 rounding', async () => {
    const f = mockFetch();
    const err = await client(f).getInvoice(bigId(1)).catch((e) => e);
    expect(err).toBeInstanceOf(FlexPointApiError);
    expect(err.isNotFound).toBe(true);
    expect(err.message).toMatch(/int64/);
  });

  it('reads FlexPoint error bodies: { Error } and RFC 9110 problem details', async () => {
    const f = mockFetch({
      handler: (c) =>
        c.target.includes('/Customers/')
          ? { status: 400, body: { title: 'One or more validation errors occurred.', status: 400, errors: { id: ['bad'] } } }
          : { status: 500, body: { Error: 'An error has occurred, please try again later!' } },
    });
    const c = client(f);
    await expect(c.getCustomer('1')).rejects.toThrow(/validation errors occurred\. \{"id":\["bad"\]\}/);
    await expect(c.listDeposits()).rejects.toThrow(/-> 500: An error has occurred/);
  });

  it('rejects a non-HTTPS base URL', () => {
    expect(() => new FlexPointReadClient({ auth: { token: 't' }, baseUrl: 'http://flexpoint.example.com' })).toThrow(/HTTPS/);
  });
});

describe('read-only surface', () => {
  it('the client exposes exactly the read methods', () => {
    const methods = Object.getOwnPropertyNames(FlexPointReadClient.prototype).filter((m) => m !== 'constructor').sort();
    expect(methods).toEqual(
      [
        'getCustomer',
        'getDeposit',
        'getInvoice',
        'getInvoiceDetails',
        'listAllCustomers',
        'listAllDeposits',
        'listAllInvoices',
        'listCustomerContacts',
        'listCustomers',
        'listDeposits',
        'listInvoiceItems',
        'listInvoices',
      ].sort(),
    );
  });

  it('the transport is not reachable from the package barrel', () => {
    expect(Object.keys(barrel)).not.toContain('FlexPointHttp');
  });
});
