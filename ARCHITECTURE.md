# Architecture

This library is a small, dependency-free client that other code builds on: Workers, scripts, and
a future `n8n-nodes-flexpoint` community node. This document explains how the modules divide
the work, and the reason for each boundary.

## Module boundaries

| Module | Responsibility | Exported |
|--------|----------------|----------|
| `json.ts` | Lossless JSON parsing: id integers become strings | yes |
| `auth.ts` | Login exchange, JWT expiry, `TokenSource` (cache, refresh, single-flight) | the login helpers; `TokenSource` is internal |
| `errors.ts` | `FlexPointApiError`, `IncompleteListError` | yes |
| `http.ts` | URL building, bearer auth, retry after a `401`, error normalization | constants only; `FlexPointHttp` is private |
| `readClient.ts` | One method per GET route, plus the `listAll*` walkers | yes |
| `model.ts` | Response and option types | types only |

`json.ts` and `model.ts` don't depend on the transport. A webhook receiver can therefore parse a
FlexPoint payload and type it without constructing a client. FlexPoint doesn't send webhooks to
this library yet, but when that support is added it belongs in a separate `webhooks.ts` that uses
these two modules.

## Read-only is enforced by what's reachable

`FlexPointHttp` has only a `get` method. The read client holds it in an ES `#private` field, and
the barrel doesn't export it, so neither TypeScript nor plain JavaScript code can send a mutating
request through this package. A test pins the read client's exact method list.

Writes will be added one endpoint at a time in a separate `FlexPointWriteClient`, each with
payload validation and a live test. The read client will never gain a mutating method.

## Ids

The OpenAPI document declares ids as `int64`. The live API issues values up to about 1.4 × 10¹⁷,
which is above `Number.MAX_SAFE_INTEGER` (about 9 × 10¹⁵). `parseFlexPointJson` scans the
response text once, tracking string state and the key each value belongs to. It quotes integers
under id-shaped keys before `JSON.parse` runs. All ids are strings regardless of size, so their
type never depends on their value. An unsafe integer under any other key throws instead of being
rounded.

## Authentication

`POST /api/v1/auth/login-merchant` with `{ "secret": "..." }` returns `{ "token": "<JWT>" }`.
The token observed in testing is HS256-signed and expires 30 minutes after it's issued.
`TokenSource` reads `exp` from the token instead of assuming a lifetime, and refreshes 60 seconds
early. Concurrent callers share one login request. After a `401`, the client logs in again and
retries once. This is safe because every request the transport sends is a GET.

## Pagination

Lists return a bare JSON array. The total arrives in the `record-count` response header; invoice
lists also carry `total-amount` and `total-balance`. `offset` counts rows. Testing found no
server cap on `page_size`: a request for 5,000 rows returned every row of a list shorter than
that. The walkers request 500 rows per page and stop at a short page. They then check two things: the row count
must equal the first page's `record-count`, and no id may appear twice.

## Keeping an n8n node in step

Verified n8n community nodes can't have runtime dependencies. A future `n8n-nodes-flexpoint`
will therefore vendor this library's transport rules: the login exchange, lossless id parsing,
and pagination. When one of those rules changes here, change the node at the same time.
