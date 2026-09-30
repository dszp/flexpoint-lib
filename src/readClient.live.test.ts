/**
 * Live read-only smoke test against the real FlexPoint API. Self-skips unless FLEXPOINT_SECRET is
 * set. Source the secret from your secret manager at run time; never commit it:
 *
 *   FLEXPOINT_SECRET="$(<your secret manager> read ...)" pnpm test
 *
 * Reads only. Walks every deposit, customer and invoice, so the request count grows with the
 * account (roughly one request per 500 records, plus a handful of detail calls).
 * `process` is declared locally so this compiles under the Node-free tsconfig (types: []).
 */
import { describe, it, expect } from 'vitest';
import { FlexPointReadClient } from './readClient.js';

declare const process: { env: Record<string, string | undefined> } | undefined;
const env = typeof process !== 'undefined' ? process!.env : {};
const SECRET = env.FLEXPOINT_SECRET;

describe.skipIf(!SECRET)('live read smoke (real FlexPoint API)', () => {
  // vitest runs a skipped describe's body to collect its tests, so build the client only with a secret.
  const client = SECRET
    ? new FlexPointReadClient({ auth: { secret: SECRET }, baseUrl: env.FLEXPOINT_BASE_URL })
    : (undefined as unknown as FlexPointReadClient);

  it('deposits: full walk matches record-count and an int64 payoutId round-trips', async () => {
    const page = await client.listDeposits({ pageSize: 1 });
    const all = await client.listAllDeposits();
    expect(all).toHaveLength(page.recordCount);
    if (all.length) {
      expect(all[0]!.payoutId).toMatch(/^\d+$/);
      const detail = await client.getDeposit(all[0]!.payoutId);
      expect(typeof detail.payout.payoutAmount).toBe('number');
    }
    console.log(`[live] deposits=${all.length}`);
  }, 60_000);

  it('customers and contacts', async () => {
    const all = await client.listAllCustomers();
    if (all.length) {
      const one = await client.getCustomer(all[0]!.customerId);
      expect(one.customerId).toBe(all[0]!.customerId);
      const contacts = await client.listCustomerContacts(one.customerId);
      for (const c of contacts) expect(c.contactId).toMatch(/^\d+$/);
    }
    console.log(`[live] customers=${all.length}`);
  }, 60_000);

  it('invoices: header totals, details and items agree', async () => {
    const page = await client.listInvoices({ pageSize: 1 });
    expect(page.totalAmount).toBeGreaterThanOrEqual(0);
    if (page.items.length) {
      const id = page.items[0]!.invoiceId;
      const details = await client.getInvoiceDetails(id);
      const items = await client.listInvoiceItems(id);
      expect(details.invoice.invoiceId).toBe(id);
      expect(items.map((i) => i.invoiceItemId)).toEqual((details.lineItems ?? []).map((i) => i.invoiceItemId));
    }
    console.log(`[live] invoices=${page.recordCount}`);
  }, 60_000);
});
