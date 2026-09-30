/**
 * Types for the FlexPoint merchant API (v1), hand-derived from the vendored OpenAPI document in
 * `reference/` and checked against live responses.
 *
 * **Ids are strings.** FlexPoint ids are int64 and many exceed `Number.MAX_SAFE_INTEGER`; the
 * client parses them losslessly (see `parseFlexPointJson`). Pass them back exactly as received.
 *
 * Money fields are JSON numbers (the API's `double`), in the merchant's currency.
 */

/** An int64 FlexPoint id, as a decimal string. */
export type FlexPointId = string;

/** Invoice lifecycle states. */
export type InvoiceStatus = 'Draft' | 'Posted' | 'Paid' | 'Processing' | 'Void';

/**
 * Offset pagination inputs. `offset` counts **rows**, not pages. The server defaults `pageSize` to
 * 50; the client rejects values below 1 and negative offsets, which the API answers with a 500.
 */
export interface PageOptions {
  offset?: number;
  pageSize?: number;
}

/** One page of a list, with the `record-count` header the API sends beside the array. */
export interface Page<T> {
  items: T[];
  /** Total rows matching the query, ignoring pagination. */
  recordCount: number;
}

/** An invoice page also carries the `total-amount` and `total-balance` headers. */
export interface InvoicePage extends Page<Invoice> {
  /** Sum of `invoiceAmount` over every matching invoice, not just this page. */
  totalAmount: number;
  /** Sum of `openBalanceAmount` over every matching invoice. */
  totalBalance: number;
}

/**
 * Filter on the user-defined `metadata` object: `{ region: 'east' }` is sent as
 * `metadata[region]=east`.
 */
export type MetadataFilter = Record<string, string>;

// ---- customers --------------------------------------------------------------------------------

export interface ListCustomersOptions extends PageOptions {
  /** Free-text search. */
  search?: string;
  /** Only children of this parent customer. */
  customerIdParent?: FlexPointId;
  /** Include child customers in the results. */
  addedChilds?: boolean;
  /** Match on the customer's `externalUri` (your system's reference). */
  externalUri?: string;
  metadata?: MetadataFilter;
}

export interface Customer {
  customerId: FlexPointId;
  name: string | null;
  addr: string | null;
  country: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  tel: string | null;
  email: string | null;
  webSite: string | null;
  /** Your system's reference for this customer, set when the record was created or updated. */
  externalUri: string | null;
  /** User-defined key/value object, or `null` when none is set. */
  metadata: Record<string, unknown> | null;
}

export interface CustomerContact {
  contactId: FlexPointId;
  fname: string | null;
  lname: string | null;
  tel: string | null;
  email: string;
  isPrimary: boolean;
}

// ---- deposits ---------------------------------------------------------------------------------

export interface ListDepositsOptions extends PageOptions {
  search?: string;
}

/** A payout to the merchant's bank account, as listed. Newest first. */
export interface Deposit {
  payoutId: FlexPointId;
  amount: number;
  /** ISO-8601 date-time **without an offset** (`2026-09-29T18:55:28`). The zone is not documented. */
  datePaid: string;
}

export interface Payout {
  /** ISO-8601 date-time in UTC. */
  paidAtUtc: string;
  /** The payment processor's payout reference. */
  processorPayoutId: string | null;
  payoutBalance: number;
  payoutAmount: number;
}

/**
 * One invoice payment inside a deposit. It references the invoice by `invoiceUri` (a UUID) and
 * `invoiceNumber`, **not** by `invoiceId`.
 */
export interface DepositItem {
  invoiceUri: string;
  invoiceNumber: string | null;
  paymentAmount: number;
  feeAmount: number;
  refundAmount: number;
  achChargeFailureRefund: boolean;
}

export interface DepositDetails {
  adminFees: number;
  payout: Payout;
  items: DepositItem[] | null;
}

// ---- invoices ---------------------------------------------------------------------------------

export interface ListInvoicesOptions extends PageOptions {
  search?: string;
  externalUri?: string;
  metadata?: MetadataFilter;
}

export interface Invoice {
  invoiceId: FlexPointId;
  customerId: FlexPointId;
  status: InvoiceStatus;
  externalUri: string | null;
  /** Date only, `YYYY-MM-DD`. */
  dtInvoice: string | null;
  /** Date only, `YYYY-MM-DD`. */
  dtDue: string | null;
  dtPosted: string | null;
  companyName: string | null;
  customerMessage: string | null;
  /** The invoice number printed on the document. */
  docNum: string | null;
  poNumber: string | null;
  contract: string | null;
  bill2Country: string | null;
  bill2Addr: string | null;
  bill2City: string | null;
  bill2State: string | null;
  bill2Zip: string | null;
  bill2Email: string | null;
  /** The invoice is set to be processed automatically. */
  autoProcess: boolean;
  /** Automatic processing is disabled (after earlier errors, or by a user). */
  autoProcessDisabled: boolean;
  /** Total including items and tax. */
  invoiceAmount: number;
  /** Items total without tax. */
  invoiceItemsAmount: number;
  /** Credit applied to the invoice. */
  creditAmount: number;
  taxAmount: number;
  /** Payments processed through FlexPoint. */
  paymentsProcessedAmount: number;
  /** All payments received, including those not processed through FlexPoint. */
  paymentsReceivedAmount: number;
  openBalanceAmount: number;
  lineItemsCount: number;
  metadata: Record<string, unknown> | null;
  /** Customer-facing payment page. */
  paymentUrl: string | null;
}

export interface InvoiceItem {
  invoiceItemId: FlexPointId;
  partNum: string | null;
  description: string | null;
  qty: number;
  unitPrice: number;
  /** Discount for the whole line, not per unit. */
  discountAmount: number;
}

export interface InvoiceDetails {
  invoice: Invoice;
  lineItems: InvoiceItem[] | null;
}
