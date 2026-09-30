# Changelog

All notable changes to `@dszp/flexpoint-lib` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-09-30

### Added

- `FlexPointReadClient` for customers, customer contacts, deposits, and invoices, including
  details and line items. The client has no write methods.
- Login from the merchant API secret, with token caching, refresh 60 seconds before the JWT's
  `exp`, one shared login for concurrent callers, and one retry after a `401`.
- `parseFlexPointJson`, which returns int64 ids as strings. Methods that take an id refuse a
  `number`.
- `listAll*` walkers that check the row count against `record-count` and reject a walk that sees
  the same id twice.
- An offline test suite, and a live smoke test that runs only when `FLEXPOINT_SECRET` is set.

### Verified against the live API

- Every read method, with all ids returned as strings and passed back without loss.
- `offset` counts rows. A `page_size` of 5,000 was honored. `page_size=0` and a negative `offset`
  return a generic `500`.
