# @dszp/flexpoint-lib

A read-only TypeScript client for the [FlexPoint](https://getflexpoint.com) merchant API. It has
no runtime dependencies and no Node APIs, so the same code runs in a Cloudflare Worker, Node 20+,
and the browser.

The client handles three things you'd otherwise have to handle yourself:

- **Token lifecycle.** You pass the merchant API secret. The client logs in, caches the 30-minute
  bearer token, refreshes it before it expires, and retries a `401` once with a fresh login.
- **Lossless int64 ids.** FlexPoint ids such as `payoutId` and `invoiceId` are 18-digit integers,
  larger than JavaScript can represent exactly. `JSON.parse` rounds them, and a rounded id returns
  `404`. The client returns every id as a string.
- **Complete lists.** The `listAll*` methods walk every page and check the result against the
  `record-count` header. If they don't match, the method throws.

This version reads only. The API's create, update, and delete endpoints are intentionally absent.

## Install

```sh
pnpm add @dszp/flexpoint-lib
```

## Get an API secret

The client needs a FlexPoint merchant API secret, which FlexPoint issues to the merchant. The
client exchanges the secret for a bearer token on each login. Store the secret in a secret manager
or a Worker secret, and never commit it.

## Use it

```ts
import { FlexPointReadClient } from '@dszp/flexpoint-lib';

const fp = new FlexPointReadClient({ auth: { secret: env.FLEXPOINT_SECRET } });

// One page, plus the total number of matching records.
const { items, recordCount } = await fp.listDeposits({ pageSize: 25 });

// Every deposit. Throws IncompleteListError if the walk can't prove it got all of them.
const deposits = await fp.listAllDeposits();

// Follow-up calls take the id exactly as it came back.
const detail = await fp.getDeposit(deposits[0].payoutId);
```

In a Cloudflare Worker, set the secret with `wrangler secret put FLEXPOINT_SECRET`. If you create
the client at module scope, one login serves every request that the isolate handles until the
token nears expiry.

### Methods

| Resource  | Methods |
|-----------|---------|
| Customers | `listCustomers`, `listAllCustomers`, `getCustomer`, `listCustomerContacts` |
| Deposits  | `listDeposits`, `listAllDeposits`, `getDeposit` |
| Invoices  | `listInvoices`, `listAllInvoices`, `getInvoice`, `getInvoiceDetails`, `listInvoiceItems` |

`listCustomers` and `listInvoices` accept `search`, `externalUri`, and a `metadata` filter.
`{ metadata: { region: 'east' } }` is sent as `metadata[region]=east`. `listCustomers` also
accepts `customerIdParent` and `addedChilds`.

`listInvoices` returns `totalAmount` and `totalBalance` along with `recordCount`. The API computes
both totals over every matching invoice, not only the returned page.

### Using a token you already have

If a token comes from somewhere else, such as an n8n credential, pass `{ auth: { token } }`. The
client uses it as-is and can't refresh it, so every call fails with `401` after it expires. Pass
`{ secret }` whenever you can.

## Ids are strings

Keep FlexPoint ids as strings from end to end:

- Store them in `TEXT` columns.
- Don't convert them with `Number()` or `parseInt`.
- If you parse FlexPoint JSON yourself, use `parseFlexPointJson`, not `JSON.parse`.

Every `get*` method refuses a `number` id with a `TypeError`, because a number above
`Number.MAX_SAFE_INTEGER` may already have been rounded. A `bigint` is accepted.

```ts
import { parseFlexPointJson } from '@dszp/flexpoint-lib';

const rows = parseFlexPointJson(await res.text()); // ids arrive as strings
```

`parseFlexPointJson` turns the integer value of every id-shaped key (`id`, `*Id`, `*_id`,
`*Ids`) into a string. Any other integer too large to represent exactly throws
`FlexPointPrecisionError` instead of being rounded.

## Pagination and completeness

`offset` counts rows, not pages. The server returns 50 rows by default. The client rejects
`pageSize` below 1 and negative offsets, because the API answers both with a generic `500`.

Lists are ordered newest first. If a record is created while a `listAll*` walk is running, every
later row shifts down by one and the walk would repeat a row. The walker detects the repeated id
and throws `IncompleteListError`. Run the walk again.

## Errors

Every HTTP failure is a `FlexPointApiError` with `status`, `method`, `path`, and the parsed
`body`. The message includes a hint when you can act on the failure:

| Status | Meaning |
|--------|---------|
| `400` on login | FlexPoint rejected the secret. |
| `401` | The token is invalid. With `{ secret }`, the client has already retried once with a new login. |
| `404` on a `get*` | No record has that id. Check that the id was never a JavaScript number. |

## Dates

`Deposit.datePaid` has no UTC offset (`2026-09-29T18:55:28`), and the API doesn't document its
time zone. `Payout.paidAtUtc` is UTC. The invoice fields `dtInvoice` and `dtDue` are dates
without a time.

## Joining deposits to invoices

A deposit's items identify invoices by `invoiceUri` (a UUID) and `invoiceNumber`, not by
`invoiceId`. The invoice record has no `invoiceUri` field. To find the invoice, search on the
number:

```ts
const { items } = await fp.listInvoices({ search: depositItem.invoiceNumber ?? '' });
```

## Development

```sh
pnpm install
pnpm test        # offline; needs no credentials
pnpm typecheck
pnpm verify      # builds, then imports dist/index.js under Node
```

The live smoke test reads from the real API. It runs only when `FLEXPOINT_SECRET` is set:

```sh
FLEXPOINT_SECRET="$(<your secret manager> read ...)" pnpm test
```

## Resources

- [FlexPoint API reference (Swagger)](https://apps.getflexpoint.com/core-api/swagger/index.html).
  A copy of the OpenAPI document is in `reference/`.
- [Architecture](ARCHITECTURE.md) and [contributing guide](CONTRIBUTING.md).

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT. This project is not affiliated with or endorsed by FlexPoint.
