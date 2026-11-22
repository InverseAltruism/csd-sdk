# Changelog

## 1.0.0 (unreleased)

The contract of version 1 of the read API. 0.1.3 was never published; its change is listed here.

- Promised from 1.0.0, on the date the documentation (`/docs#cairnx-v1-notice`) states: the six routes; each
  parameter's name, grammar and meaning; each list's orders and cursor grammars; the envelope's fields; each row
  field's name and meaning; the error codes with their statuses; what an answer means; what `rev` promises.
- Added in any release, without notice: a route, an optional parameter (an older server refuses it), a field, a value
  of an open set (a status, `mint`, an event's `code`, an error code), a higher `limit` maximum.
- Not promised: the `message` texts, the key order in the JSON, the default `limit`, the presence of `total` (sent on
  every page by these handlers), the form of `rev` beyond an opaque string, and anything about the hosts that serve
  the API (limits, availability).
- Retiring a route or a field: it is marked deprecated, with the date, in this file and the documentation, served
  unchanged for six months from that date, then removed in a release whose entry here names it. A change of meaning
  is a new API version, `/api/cairnx/v2/`.
- cairnx-core stays an exact peer, so a host keeps one core: each cairnx-core release is followed by a cairnx-api
  release that peers on it, a 1.0.x when nothing else changes.

Changes since 0.1.2:

- `names` takes `order=length`: shortest name first, names of one length bytewise. Its cursor is `<length>:<name>`; a
  cursor whose length is not its name's is refused as INVALID_QUERY on `after`. The default order stays `name`.
- cairnx-core 0.2.10 is the exact peer.
- No route, parameter, row field, envelope field, error code or cursor grammar was removed or renamed. The order of
  every string key was bytewise before and is now pinned under foreign locales (`test/locale.test.ts`).
- `rev` moves with the package version, as at every release: after a host's upgrade an `at` with the `rev` of a 0.1.x
  answer is refused with 409 SNAPSHOT_NOT_HELD and the newest `at`, so a pinned walk starts again from page 1. A
  cursor stays a valid position: no cursor grammar changed.

## 0.1.2

- A peer-only step: cairnx-core 0.2.9 is the exact peer. No route, parameter, row, envelope field, error code or
  cursor grammar changed; `rev` moves with the package version.

## 0.1.1

- A peer-only step: cairnx-core 0.2.8 is the exact peer. No route, parameter, row, envelope field, error code or cursor
  grammar changed; `rev` moves with the package version, as it does at every release.

## 0.1.0 (2026-11-19)

- First release, made for one consumer: the CairnX resolver, which is to mount the handlers. No public HTTP route
  serves these reads yet, and this is not the 1.0 contract: any part of it can change in any release before 1.0.0.
- Entry `.`, the types and parser of the CairnX read API, version 1, as they stand before 1.0: the envelope (`At`, `Page`, `Refusal`), the
  rows of the six lists over cairnx-core's state types (`fillCount` and `offerCount` in place of the unbounded
  arrays, no note text in `EventRow`, the growable status and mint unions `Open`), the error codes with their HTTP
  statuses, the closed parameter table of each route and `parseQuery`, which refuses an unknown, repeated, empty,
  malformed or out-of-range parameter with its name (heights and positions at most 15 digits), the cursor codec of
  each list order, and `CAIRNX_API_VERSION`. cairnx-core is an exact peer dependency.
- `./handlers`: `prepareView(state, { height, hash, input, core })`, the frozen view of one published state with
  `rev`, and `answer(held, route, query)`, the `{ status, body }` of a v1 read of any of the six lists from the views
  held. `events` is the applied log in (height, pos) order, each entry once; `holders` reads an unknown ticker as an
  empty list and adds nothing to the view; `offers` filters on `status` and `kind`. A page never ends between two rows
  of one key, so a repeated event below V29 is never split across pages. Dependency: `@noble/hashes`, at
  cairnx-core's version.
