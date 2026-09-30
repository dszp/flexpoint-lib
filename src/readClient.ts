import { FlexPointHttp, MERCHANT_PREFIX, type FlexPointHttpConfig, type Query } from './http.js';
import { IncompleteListError } from './errors.js';
import type {
  Customer,
  CustomerContact,
  Deposit,
  DepositDetails,
  FlexPointId,
  Invoice,
  InvoiceDetails,
  InvoiceItem,
  InvoicePage,
  ListCustomersOptions,
  ListDepositsOptions,
  ListInvoicesOptions,
  MetadataFilter,
  Page,
  PageOptions,
} from './model.js';

/**
 * Page size the `*All` walkers request. The API applied no cap in testing (a request for 5000 rows
 * returned every row of a list shorter than that); 500 keeps a single response to a few hundred KB.
 */
export const WALK_PAGE_SIZE = 500;

/** Runaway guard for the walkers: 200 pages × 500 rows = 100,000 records. */
const DEFAULT_MAX_PAGES = 200;

export interface WalkOptions {
  /** Override the runaway guard. */
  maxPages?: number;
}

export type FlexPointReadClientConfig = FlexPointHttpConfig;

/**
 * Read-only client for the FlexPoint merchant API. One method per GET endpoint, plus an `*All`
 * companion for each list that walks the whole collection and checks it against `record-count`.
 *
 * Create, update and delete endpoints exist upstream and are intentionally absent here.
 */
export class FlexPointReadClient {
  readonly #http: FlexPointHttp;

  constructor(config: FlexPointReadClientConfig) {
    this.#http = new FlexPointHttp(config);
  }

  // ---- customers ------------------------------------------------------------------------------

  async listCustomers(opts: ListCustomersOptions = {}): Promise<Page<Customer>> {
    return this.#page<Customer>('/Customers', customerQuery(opts), opts);
  }

  async listAllCustomers(opts: Omit<ListCustomersOptions, keyof PageOptions> & WalkOptions = {}): Promise<Customer[]> {
    const { maxPages, ...filters } = opts;
    return this.#walk<Customer>('/Customers', customerQuery(filters), 'customerId', maxPages);
  }

  async getCustomer(customerId: FlexPointId | bigint): Promise<Customer> {
    return (await this.#http.get<Customer>(`${MERCHANT_PREFIX}/Customers/${idSegment(customerId)}`)).body;
  }

  /** Every contact on a customer. The endpoint is not paginated. */
  async listCustomerContacts(customerId: FlexPointId | bigint): Promise<CustomerContact[]> {
    return (await this.#http.get<CustomerContact[]>(`${MERCHANT_PREFIX}/Customers/${idSegment(customerId)}/contacts`)).body;
  }

  // ---- deposits -------------------------------------------------------------------------------

  /** Payouts to the merchant, newest first. */
  async listDeposits(opts: ListDepositsOptions = {}): Promise<Page<Deposit>> {
    return this.#page<Deposit>('/Deposits', { search: opts.search }, opts);
  }

  async listAllDeposits(opts: Omit<ListDepositsOptions, keyof PageOptions> & WalkOptions = {}): Promise<Deposit[]> {
    return this.#walk<Deposit>('/Deposits', { search: opts.search }, 'payoutId', opts.maxPages);
  }

  /** The payout plus the invoice payments it settled. Takes the `payoutId` from a deposit. */
  async getDeposit(payoutId: FlexPointId | bigint): Promise<DepositDetails> {
    return (await this.#http.get<DepositDetails>(`${MERCHANT_PREFIX}/Deposits/${idSegment(payoutId)}`)).body;
  }

  // ---- invoices -------------------------------------------------------------------------------

  async listInvoices(opts: ListInvoicesOptions = {}): Promise<InvoicePage> {
    const res = await this.#http.get<Invoice[]>(`${MERCHANT_PREFIX}/Invoices`, {
      ...invoiceQuery(opts),
      ...pageQuery(opts),
    });
    return {
      items: res.body,
      recordCount: numericHeader(res.headers, 'record-count'),
      totalAmount: numericHeader(res.headers, 'total-amount'),
      totalBalance: numericHeader(res.headers, 'total-balance'),
    };
  }

  async listAllInvoices(opts: Omit<ListInvoicesOptions, keyof PageOptions> & WalkOptions = {}): Promise<Invoice[]> {
    const { maxPages, ...filters } = opts;
    return this.#walk<Invoice>('/Invoices', invoiceQuery(filters), 'invoiceId', maxPages);
  }

  async getInvoice(invoiceId: FlexPointId | bigint): Promise<Invoice> {
    return (await this.#http.get<Invoice>(`${MERCHANT_PREFIX}/Invoices/${idSegment(invoiceId)}`)).body;
  }

  /** The invoice and its line items in one request. */
  async getInvoiceDetails(invoiceId: FlexPointId | bigint): Promise<InvoiceDetails> {
    return (await this.#http.get<InvoiceDetails>(`${MERCHANT_PREFIX}/Invoices/${idSegment(invoiceId)}/details`)).body;
  }

  /** Line items only. The endpoint is not paginated. */
  async listInvoiceItems(invoiceId: FlexPointId | bigint): Promise<InvoiceItem[]> {
    return (await this.#http.get<InvoiceItem[]>(`${MERCHANT_PREFIX}/Invoices/${idSegment(invoiceId)}/items`)).body;
  }

  // ---- internals ------------------------------------------------------------------------------

  async #page<T>(resource: string, filters: Query, opts: PageOptions): Promise<Page<T>> {
    const res = await this.#http.get<T[]>(`${MERCHANT_PREFIX}${resource}`, { ...filters, ...pageQuery(opts) });
    return { items: res.body, recordCount: numericHeader(res.headers, 'record-count') };
  }

  /**
   * Offset walk at {@link WALK_PAGE_SIZE}. Stops on a short page, then asserts the row count
   * against the first page's `record-count` and that no id appeared twice.
   */
  async #walk<T>(resource: string, filters: Query, idKey: keyof T & string, maxPages = DEFAULT_MAX_PAGES): Promise<T[]> {
    const path = `${MERCHANT_PREFIX}${resource}`;
    const out: T[] = [];
    let expected: number | undefined;
    for (let page = 0; page < maxPages; page++) {
      const res = await this.#http.get<T[]>(path, { ...filters, offset: page * WALK_PAGE_SIZE, page_size: WALK_PAGE_SIZE });
      expected ??= numericHeader(res.headers, 'record-count');
      out.push(...res.body);
      if (res.body.length < WALK_PAGE_SIZE || out.length >= expected) {
        const unique = new Set(out.map((row) => row[idKey])).size;
        if (out.length !== expected || unique !== out.length) {
          throw new IncompleteListError(path, expected, out.length, out.length - unique);
        }
        return out;
      }
    }
    throw new Error(`FlexPoint ${path}: exceeded ${maxPages} pages; refusing to continue.`);
  }
}

/**
 * An id as a path segment. Numbers are refused outright: an int64 id that has been a JS number may
 * already be rounded, and the resulting request would 404 or, worse, hit a different record.
 */
function idSegment(id: FlexPointId | bigint): string {
  const s = typeof id === 'bigint' ? id.toString() : id;
  if (typeof s !== 'string' || !/^\d+$/.test(s)) {
    throw new TypeError(
      `FlexPoint id must be a decimal string or bigint, got ${typeof id === 'number' ? `the number ${id} (int64 ids lose precision as numbers)` : JSON.stringify(id)}`,
    );
  }
  return s;
}

function pageQuery(opts: PageOptions): Query {
  const { offset, pageSize } = opts;
  if (offset !== undefined && (!Number.isInteger(offset) || offset < 0)) {
    throw new RangeError(`offset must be an integer >= 0, got ${offset}`);
  }
  if (pageSize !== undefined && (!Number.isInteger(pageSize) || pageSize < 1)) {
    throw new RangeError(`pageSize must be an integer >= 1, got ${pageSize}`);
  }
  return { offset, page_size: pageSize };
}

function metadataQuery(metadata: MetadataFilter | undefined): Query {
  const q: Query = {};
  for (const [k, v] of Object.entries(metadata ?? {})) q[`metadata[${k}]`] = v;
  return q;
}

function customerQuery(opts: Omit<ListCustomersOptions, keyof PageOptions>): Query {
  return {
    search: opts.search,
    customer_id_parent: opts.customerIdParent === undefined ? undefined : idSegment(opts.customerIdParent),
    added_childs: opts.addedChilds,
    external_uri: opts.externalUri,
    ...metadataQuery(opts.metadata),
  };
}

function invoiceQuery(opts: Omit<ListInvoicesOptions, keyof PageOptions>): Query {
  return { search: opts.search, external_uri: opts.externalUri, ...metadataQuery(opts.metadata) };
}

/** A numeric response header. Missing or non-numeric is an error: the walkers depend on it. */
function numericHeader(headers: Headers, name: string): number {
  const raw = headers.get(name);
  const n = raw === null ? NaN : Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`FlexPoint response is missing a numeric "${name}" header (got ${JSON.stringify(raw)}).`);
  }
  return n;
}
